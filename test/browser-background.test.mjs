import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { registerBackground } from "../extension/background.mjs";
import { BrowserController } from "../extension/controller.mjs";

const SESSION = randomUUID();
const POPUP = { id: "extid", url: "chrome-extension://extid/popup.html" };

function fakeChromeApi({ storage = {}, storageGate } = {}) {
  const store = { ...storage };
  const listeners = { message: [] };
  const ports = [];
  const api = {
    storage: {
      local: {
        get: async (key) => {
          if (storageGate) {
            await storageGate;
          }
          if (typeof key === "string") {
            return Object.hasOwn(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        set: async (entries) => {
          Object.assign(store, entries);
        },
      },
    },
    runtime: {
      id: "extid",
      lastError: null,
      getURL: (p) => `chrome-extension://extid/${p}`,
      connectNative: () => {
        const port = {
          messages: [],
          listeners: { message: [], disconnect: [] },
          posted: [],
          disconnected: false,
          postMessage(message) {
            this.posted.push(message);
          },
          disconnect() {
            this.disconnected = true;
            for (const fn of this.listeners.disconnect) {
              fn();
            }
          },
          onMessage: { addListener: (fn) => port.listeners.message.push(fn) },
          onDisconnect: { addListener: (fn) => port.listeners.disconnect.push(fn) },
        };
        ports.push(port);
        return port;
      },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    action: {
      badge: null,
      setBadgeBackgroundColor() {},
      setBadgeText({ text }) {
        this.badge = text;
      },
    },
    tabs: {
      map: new Map(),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      create: async ({ url }) => {
        const tab = { id: 500, url, groupId: -1, title: "" };
        api.tabs.map.set(tab.id, tab);
        return tab;
      },
      get: async (id) => {
        const tab = api.tabs.map.get(id);
        if (!tab) {
          throw new Error("no tab");
        }
        return { ...tab };
      },
      group: async ({ tabIds, groupId }) => {
        for (const id of tabIds) {
          api.tabs.map.get(id).groupId = groupId ?? 7;
        }
        return groupId ?? 7;
      },
    },
    tabGroups: { get: async () => ({ id: 7, windowId: 1 }), update: async () => {} },
    windows: { getAll: async () => [{ id: 1, type: "normal", incognito: false }] },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onDetach: { addListener() {} },
      onEvent: { addListener() {} },
    },
  };
  const send = (message, sender = POPUP) => new Promise((resolve) => {
    for (const fn of listeners.message) {
      if (fn(message, sender, resolve)) {
        return;
      }
    }
    resolve(undefined);
  });
  return { api, ports, send, store };
}

test("popup connect/status flows and foreign senders are ignored", async () => {
  const { api, ports, send } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);

  const foreign = await send({ type: "status" }, { id: "other-ext", url: "chrome-extension://other/x.html" });
  assert.equal(foreign, undefined);
  const tabSender = await send({ type: "status" }, { ...POPUP, tab: { id: 3 } });
  assert.equal(tabSender, undefined);

  const status0 = await send({ type: "status" });
  assert.equal(status0.result.connected, false);
  const connected = await send({ type: "connect" });
  assert.equal(connected.result.connected, true);
  assert.equal(ports.length, 1);
  const status1 = await send({ type: "status" });
  assert.equal(status1.result.connected, true);
});

test("approve is rejected while disconnected and allowed while connected", async () => {
  const { api, send } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  const started = await controller.request(SESSION, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  const denied = await send({ type: "approve", taskId: started.taskId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "browser_unavailable");
  assert.equal(controller.listTasks()[0].status, "pending");
  await send({ type: "connect" });
  const allowed = await send({ type: "approve", taskId: started.taskId });
  assert.equal(allowed.ok, true);
});

test("a stale port's late replies and disconnect do not affect the live port", async () => {
  const { api, ports, send } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  await send({ type: "connect" });
  const first = ports[0];
  const started = await controller.request(SESSION, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  await send({ type: "disconnect" });
  first.listeners.message.forEach((fn) => fn({
    id: "req1", sessionId: SESSION, method: "browser_task_status", params: { taskId: started.taskId },
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(first.posted.length, 0);

  await send({ type: "connect" });
  const second = ports[1];
  const later = randomUUID();
  await controller.request(later, "browser_start_task", { title: "t2", url: "https://b.example" });
  assert.equal(controller.listTasks().length, 2);
  first.listeners.message.forEach((fn) => fn({
    id: "req2", sessionId: later, method: "browser_task_status", params: { taskId: started.taskId },
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(first.posted.length, 0);
  api.runtime.lastError = { message: "old port died" };
  first.listeners.disconnect.forEach((fn) => fn());
  const status = await send({ type: "status" });
  assert.equal(status.result.connected, true);
  assert.equal(status.result.lastError, null);

  api.runtime.lastError = { message: "host gone" };
  second.listeners.disconnect.forEach((fn) => fn());
  const status2 = await send({ type: "status" });
  assert.equal(status2.result.connected, false);
  assert.equal(status2.result.lastError, "host gone");
});

test("a stored autoApprove auto-approves a native start_task sent during settings load", async () => {
  let release;
  const storageGate = new Promise((resolve) => {
    release = resolve;
  });
  const { api, ports, send } = fakeChromeApi({ storage: { autoApprove: true }, storageGate });
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  await send({ type: "connect" });
  ports[0].listeners.message.forEach((fn) => fn({
    id: "req1",
    sessionId: SESSION,
    method: "browser_start_task",
    params: { title: "t", url: "https://example.com/" },
  }));
  release();
  let reply;
  for (let i = 0; i < 50 && !reply; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    reply = ports[0].posted.find((m) => m.id === "req1");
  }
  assert.equal(reply.result.status, "active");
  assert.equal(reply.result.tabs.length, 1);
  const status = await send({ type: "status" });
  assert.equal(status.result.autoApprove, true);
});

test("status reports autoApprove false with empty storage", async () => {
  const { api, send } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  const status = await send({ type: "status" });
  assert.equal(status.result.autoApprove, false);
});

test("set_auto_approve validates, persists, and works while disconnected", async () => {
  const { api, send, store } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  const bad = await send({ type: "set_auto_approve", enabled: "yes" });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid_params");
  const reply = await send({ type: "set_auto_approve", enabled: true });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.result, { autoApprove: true });
  assert.equal(store.autoApprove, true);
  const status = await send({ type: "status" });
  assert.equal(status.result.autoApprove, true);
});

test("disconnect revokes all tasks and closes the port", async () => {
  const { api, ports, send } = fakeChromeApi();
  const controller = new BrowserController(api, { sleep: async () => {} });
  registerBackground(api, controller);
  await send({ type: "connect" });
  await controller.request(SESSION, "browser_start_task", { title: "t", url: "https://a.example" });
  await send({ type: "disconnect" });
  assert.equal(ports[0].disconnected, true);
  assert.equal(controller.listTasks()[0].status, "stopped");
});
