import assert from "node:assert/strict";
import test from "node:test";

import { initPopup } from "../extension/popup.mjs";

function fakeElement(tag = "div") {
  return {
    tag,
    children: [],
    handlers: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: false,
    type: "",
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    addEventListener(event, fn) {
      this.handlers[event] = fn;
    },
    click() {
      return this.handlers.click?.();
    },
  };
}

function fakePopup(sendMessage) {
  const ids = [
    "status", "error", "connect", "disconnect", "refresh",
    "pending", "active", "no-pending", "no-active", "auto-approve",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, fakeElement()]));
  const document = {
    getElementById: (id) => elements[id],
    createElement: (tag) => fakeElement(tag),
  };
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: async (message) => {
        sent.push(message);
        return sendMessage(message);
      },
    },
  };
  return { elements, document, chrome, sent };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test("connect click sends connect then refreshes status", async () => {
  const state = { connected: false, lastError: null, tasks: [] };
  const { elements, document, chrome, sent } = fakePopup((message) => {
    if (message.type === "connect") {
      state.connected = true;
      return { ok: true, result: { connected: true } };
    }
    return { ok: true, result: state };
  });
  initPopup({ document, chrome, setInterval: null });
  await tick();
  assert.equal(elements.status.textContent, "Disconnected");
  elements.connect.click();
  await tick();
  assert.deepEqual(sent.map((m) => m.type), ["status", "connect", "status"]);
  assert.equal(elements.status.textContent, "Connected");
  assert.equal(elements.connect.disabled, true);
});

test("a rejected approval re-enables Allow and shows the action error", async () => {
  const task = { taskId: "t-1", title: "Shop", url: "https://x.example", status: "pending" };
  const state = { connected: true, lastError: null, tasks: [task] };
  const { elements, document, chrome } = fakePopup((message) => {
    if (message.type === "approve") {
      return { ok: false, error: { code: "boom", message: "approval failed" } };
    }
    return { ok: true, result: state };
  });
  initPopup({ document, chrome, setInterval: null });
  await tick();
  const item = elements.pending.children[0];
  const buttons = item.children[item.children.length - 1].children;
  const allow = buttons.find((b) => b.textContent === "Allow");
  allow.click();
  await tick();
  assert.equal(allow.disabled, false);
  assert.equal(allow.textContent, "Allow");
  assert.equal(elements.error.hidden, false);
  assert.equal(elements.error.textContent, "approval failed");
});

test("the auto-approve checkbox reflects status.autoApprove", async () => {
  const state = { connected: true, lastError: null, tasks: [], autoApprove: true };
  const { elements, document, chrome } = fakePopup(() => ({ ok: true, result: state }));
  initPopup({ document, chrome, setInterval: null });
  await tick();
  assert.equal(elements["auto-approve"].checked, true);
});

test("changing the checkbox sends set_auto_approve and re-enables it", async () => {
  const state = { connected: true, lastError: null, tasks: [], autoApprove: false };
  const { elements, document, chrome, sent } = fakePopup((message) => {
    if (message.type === "set_auto_approve") {
      state.autoApprove = message.enabled;
      return { ok: true, result: { autoApprove: message.enabled } };
    }
    return { ok: true, result: state };
  });
  initPopup({ document, chrome, setInterval: null });
  await tick();
  assert.equal(elements["auto-approve"].checked, false);
  elements["auto-approve"].checked = true;
  elements["auto-approve"].handlers.change();
  await tick();
  assert.deepEqual(
    sent.find((m) => m.type === "set_auto_approve"),
    { type: "set_auto_approve", enabled: true },
  );
  assert.equal(elements["auto-approve"].disabled, false);
  assert.equal(elements["auto-approve"].checked, true);
});

test("a rejected set_auto_approve reverts the checkbox and shows the error", async () => {
  const state = { connected: true, lastError: null, tasks: [], autoApprove: false };
  const { elements, document, chrome } = fakePopup((message) => {
    if (message.type === "set_auto_approve") {
      return { ok: false, error: { code: "boom", message: "storage failed" } };
    }
    return { ok: true, result: state };
  });
  initPopup({ document, chrome, setInterval: null });
  await tick();
  elements["auto-approve"].checked = true;
  elements["auto-approve"].handlers.change();
  await tick();
  assert.equal(elements["auto-approve"].checked, false);
  assert.equal(elements["auto-approve"].disabled, false);
  assert.equal(elements.error.hidden, false);
  assert.equal(elements.error.textContent, "storage failed");
});
