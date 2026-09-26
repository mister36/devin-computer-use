import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { BrowserController, BrowserTaskError } from "../extension/controller.mjs";

const SESSION_A = randomUUID();
const SESSION_B = randomUUID();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pngBase64(width, height) {
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4),
    Buffer.from("IHDR"),
    Buffer.alloc(8),
    Buffer.alloc(16),
  ]);
  bytes.writeUInt32BE(Math.max(1, Math.round(width)), 16);
  bytes.writeUInt32BE(Math.max(1, Math.round(height)), 20);
  return bytes.toString("base64");
}

function fakeChrome({
  viewport = { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800 },
  deviceFactor = 1,
  windows = [{ id: 1, type: "normal", incognito: false }],
} = {}) {
  let nextTabId = 100;
  let nextGroupId = 7;
  const tabs = new Map();
  const groups = new Map();
  const attached = new Set();
  const sent = [];
  const listeners = {
    tabsRemoved: [],
    tabsUpdated: [],
    debugEvent: [],
    debugDetach: [],
  };
  const chrome = {
    runtime: { id: "extid", getURL: (p) => `chrome-extension://extid/${p}`, lastError: null },
    windows: {
      getAll: async (query) => windows.filter((w) => !query?.windowTypes || query.windowTypes.includes(w.type)),
    },
    tabs: {
      create: async ({ url, active, windowId }) => {
        if (!windows.some((w) => w.id === windowId && w.type === "normal")) {
          throw new Error("No window");
        }
        const tab = { id: nextTabId++, url, title: "", active, groupId: -1, windowId };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      get: async (id) => {
        const tab = tabs.get(id);
        if (!tab) {
          throw new Error("No tab with id.");
        }
        return { ...tab };
      },
      group: async ({ tabIds, groupId }) => {
        const gid = groupId ?? nextGroupId++;
        if (!groups.has(gid)) {
          groups.set(gid, { id: gid, title: "", color: "", windowId: tabs.get(tabIds[0]).windowId });
        }
        for (const id of tabIds) {
          const tab = tabs.get(id);
          if (tab.windowId !== groups.get(gid).windowId) {
            throw new Error("Tabs must share the group's window");
          }
          tab.groupId = gid;
        }
        return gid;
      },
      onRemoved: { addListener: (fn) => listeners.tabsRemoved.push(fn) },
      onUpdated: { addListener: (fn) => listeners.tabsUpdated.push(fn) },
    },
    tabGroups: {
      update: async (id, props) => Object.assign(groups.get(id), props),
      get: async (id) => {
        const group = groups.get(id);
        if (!group) {
          throw new Error("No group");
        }
        return { ...group };
      },
    },
    debugger: {
      attach: async (target) => {
        attached.add(target.tabId);
      },
      detach: async (target) => {
        attached.delete(target.tabId);
      },
      sendCommand: async (target, method, params) => {
        sent.push({ tabId: target.tabId, method, params });
        if (method === "Page.getLayoutMetrics") {
          return { cssVisualViewport: viewport };
        }
        if (method === "Page.captureScreenshot") {
          return {
            data: pngBase64(
              params.clip.width * params.clip.scale * deviceFactor,
              params.clip.height * params.clip.scale * deviceFactor,
            ),
          };
        }
        if (method === "Accessibility.getFullAXTree") {
          return {
            nodes: [
              { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" } },
              { nodeId: "2", role: { value: "button" }, name: { value: "OK" } },
            ],
          };
        }
        if (method === "Page.navigate") {
          tabs.get(target.tabId).url = params.url;
          tabs.get(target.tabId).loaderId = `loader-${params.url}`;
          return { frameId: "root", loaderId: tabs.get(target.tabId).loaderId };
        }
        if (method === "Page.getFrameTree") {
          return {
            frameTree: { frame: { id: "root", loaderId: tabs.get(target.tabId).loaderId || "l0" } },
          };
        }
        return {};
      },
      onDetach: { addListener: (fn) => listeners.debugDetach.push(fn) },
      onEvent: { addListener: (fn) => listeners.debugEvent.push(fn) },
    },
  };
  return {
    chrome,
    tabs,
    groups,
    attached,
    sent,
    windows,
    emit: {
      removed: (tabId) => listeners.tabsRemoved.forEach((fn) => fn(tabId)),
      updated: (tabId, changeInfo, tab) => listeners.tabsUpdated.forEach((fn) => fn(tabId, changeInfo, tab)),
      detach: (tabId) => listeners.debugDetach.forEach((fn) => fn({ tabId })),
      frameNavigated: (tabId, url) => listeners.debugEvent.forEach((fn) => fn(
        { tabId },
        "Page.frameNavigated",
        { frame: { url, parentId: undefined } },
      )),
      sameDocNavigated: (tabId, url) => listeners.debugEvent.forEach((fn) => fn(
        { tabId },
        "Page.navigatedWithinDocument",
        { frame: { id: "root" }, url },
      )),
    },
  };
}

function setup(options) {
  const fx = fakeChrome(options);
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  return { controller, fx };
}

async function activeTask(controller, sessionId = SESSION_A, title = "shop") {
  const started = await controller.request(sessionId, "browser_start_task", {
    title,
    url: "https://example.com/",
  });
  await controller.approve(started.taskId);
  const status = await controller.request(sessionId, "browser_task_status", { taskId: started.taskId });
  return { taskId: started.taskId, tabId: status.tabs[0].tabId, status };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof BrowserTaskError);
    if (code instanceof RegExp) {
      assert.match(error.code, code);
    } else {
      assert.equal(error.code, code, error.message);
    }
    return true;
  });
}

test("start_task is pending and creates no tabs until approved", async () => {
  const { controller, fx } = setup();
  const result = await controller.request(SESSION_A, "browser_start_task", {
    title: "shop",
    url: "https://example.com/",
  });
  assert.equal(result.status, "pending");
  assert.match(result.message, /Approve this task/);
  assert.equal(fx.tabs.size, 0);
  assert.equal(fx.sent.length, 0);
  const status = await controller.request(SESSION_A, "browser_task_status", { taskId: result.taskId });
  assert.equal(status.status, "pending");
});

test("setAutoApprove(true) starts new tasks active without the pending step", async () => {
  const { controller, fx } = setup();
  const pending = await controller.request(SESSION_A, "browser_start_task", {
    title: "first", url: "https://example.com/",
  });
  assert.equal(pending.status, "pending");
  controller.setAutoApprove(true);
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "shop", url: "https://example.com/",
  });
  assert.equal(started.status, "active");
  assert.equal(started.tabs.length, 1);
  assert.equal(started.tabs[0].url, "https://example.com/");
  const tab = fx.tabs.get(started.tabs[0].tabId);
  assert.ok(fx.groups.has(tab.groupId));
  assert.ok(fx.attached.has(started.tabs[0].tabId));
  const earlier = controller.listTasks().find((task) => task.taskId === pending.taskId);
  assert.equal(earlier.status, "pending");
});

test("auto-approve reports setup failures as a failed task", async () => {
  const fx = fakeChrome();
  fx.chrome.tabs.create = async () => {
    throw new Error("no window");
  };
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  controller.setAutoApprove(true);
  const result = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com/",
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /no window/i);
  assert.equal(controller.listTasks()[0].status, "failed");
});

test("approve creates a background tab in a named group and attaches the debugger", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const tab = fx.tabs.get(tabId);
  assert.equal(tab.active, false);
  assert.equal(tab.url, "https://example.com/");
  assert.equal(tab.windowId, 1);
  const group = fx.groups.get(tab.groupId);
  assert.equal(group.title, "Devin — shop");
  assert.equal(group.color, "blue");
  assert.ok(fx.attached.has(tabId));
  assert.ok(fx.sent.some((c) => c.method === "Page.enable" && c.tabId === tabId));
  const status = await controller.request(SESSION_A, "browser_task_status", { taskId });
  assert.equal(status.status, "active");
});

test("approve fails clearly when no normal window exists", async () => {
  const { controller, fx } = setup({ windows: [{ id: 9, type: "popup", incognito: false }] });
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  const summary = await controller.approve(started.taskId);
  assert.equal(summary.status, "failed");
  assert.match(summary.error, /no.*window|no_window/i);
  assert.equal(fx.tabs.size, 0);
});

test("state returns screenshot, tree and observation pinned to the task tab", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  assert.equal(state.url, "https://example.com/");
  assert.equal(state.viewport.width, 1000);
  assert.equal(state.screenshot.width, 1000);
  assert.equal(state.screenshot.height, 800);
  assert.equal(state.screenshot.scale, 1);
  assert.equal(state.screenshot.scaleY, 1);
  assert.equal(state.tree[0].role, "RootWebArea");
  assert.ok(UUID_RE.test(state.observationId));
  const shots = fx.sent.filter((c) => c.method === "Page.captureScreenshot");
  assert.equal(shots.length, 1);
  assert.equal(shots[0].tabId, tabId);
  assert.equal(shots[0].params.fromSurface, true);
  assert.equal(shots[0].params.captureBeyondViewport, false);
  assert.ok(fx.sent.every((c) => c.method !== "Page.bringToFront"));
});

test("click maps screenshot pixels to CSS via the measured scale", async () => {
  const { controller, fx } = setup({
    viewport: { pageX: 0, pageY: 0, clientWidth: 2560, clientHeight: 800 },
  });
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  assert.equal(state.viewport.scale, 0.5);
  assert.equal(state.screenshot.width, 1280);
  await controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 100, y: 50,
  });
  const presses = fx.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(presses[0].params.type, "mousePressed");
  assert.equal(presses[0].params.x, 200);
  assert.equal(presses[0].params.y, 100);
  assert.equal(presses[1].params.type, "mouseReleased");
});

test("retina captures trigger one recapture and keep mapping consistent", async () => {
  const { controller, fx } = setup({ deviceFactor: 2 });
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  const shots = fx.sent.filter((c) => c.method === "Page.captureScreenshot");
  assert.equal(shots.length, 2);
  assert.ok(Math.max(state.screenshot.width, state.screenshot.height) <= 1281);
  assert.equal(state.screenshot.scale, state.screenshot.width / state.viewport.width);
  const state2 = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state2.observationId, x: 10, y: 10,
  });
  const presses = fx.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(presses[0].params.x, 10 / state2.screenshot.scale);
});

test("input requires a fresh matching observation; navigation invalidates it", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  fx.emit.frameNavigated(tabId, "https://example.com/next");
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 10, y: 10,
  }), "stale_observation");
  const fresh = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.request(SESSION_A, "browser_type_text", {
    taskId, tabId, observationId: fresh.observationId, text: "hi",
  });
  await rejects(controller.request(SESSION_A, "browser_type_text", {
    taskId, tabId, observationId: fresh.observationId, text: "again",
  }), "stale_observation");
});

test("same-document navigation events invalidate the observation", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  fx.emit.sameDocNavigated(tabId, "https://example.com/#section");
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 10, y: 10,
  }), "stale_observation");
});

test("url drift reported by tabs.get invalidates without an event", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  fx.tabs.get(tabId).url = "https://example.com/hijacked";
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 10, y: 10,
  }), "stale_observation");
});

test("navigation between guard and input sends no commands", async () => {
  const fx = fakeChrome();
  let intercepted = false;
  const originalGet = fx.chrome.tabs.get;
  fx.chrome.tabs.get = async (id) => {
    const info = await originalGet(id);
    if (intercepted) {
      info.url = "https://evil.example/";
    }
    return info;
  };
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  intercepted = true;
  const before = fx.sent.filter((c) => c.method.startsWith("Input.")).length;
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 10, y: 10,
  }), /stale_observation|invalid_url/);
  const after = fx.sent.filter((c) => c.method.startsWith("Input.")).length;
  assert.equal(after - before, 0);
});

test("browser_navigate validates the URL and returns fresh state", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_navigate", {
    taskId, tabId, url: "https://example.org/page",
  });
  assert.equal(state.url, "https://example.org/page");
  assert.ok(fx.sent.some((c) => c.method === "Page.navigate" && c.params.url === "https://example.org/page"));
  await rejects(controller.request(SESSION_A, "browser_navigate", {
    taskId, tabId, url: "javascript:alert(1)",
  }), "invalid_url");
});

test("navigation errors surface as navigation_failed, timeouts as page_loading", async () => {
  const fx = fakeChrome();
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId, tabId } = await activeTask(controller);
  const original = fx.chrome.debugger.sendCommand;
  fx.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.navigate") {
      return { frameId: "root", errorText: "net::ERR_NAME_NOT_RESOLVED" };
    }
    return original(target, method, params);
  };
  await rejects(controller.request(SESSION_A, "browser_navigate", {
    taskId, tabId, url: "https://missing.example",
  }), "navigation_failed");

  fx.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.navigate") {
      return { frameId: "root", loaderId: "never" };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "root", loaderId: "old" } } };
    }
    return original(target, method, params);
  };
  let ticks = 0;
  const controller2 = new BrowserController(fx.chrome, { sleep: async () => {
    ticks += 1;
  } });
  const started2 = await controller2.request(SESSION_B, "browser_start_task", {
    title: "t2", url: "https://example.com",
  });
  await controller2.approve(started2.taskId);
  const status2 = await controller2.request(SESSION_B, "browser_task_status", { taskId: started2.taskId });
  await rejects(controller2.request(SESSION_B, "browser_navigate", {
    taskId: started2.taskId, tabId: status2.tabs[0].tabId, url: "https://slow.example",
  }), "page_loading");
  assert.ok(ticks >= 50);
});

test("rejects unsupported schemes and credential URLs at start", async () => {
  const { controller } = setup();
  for (const url of [
    "chrome://settings",
    "file:///etc/passwd",
    "data:text/html,hi",
    "devtools://x",
    "ws://x",
    "https://user:pw@example.com/",
  ]) {
    await rejects(controller.request(SESSION_A, "browser_start_task", { title: "t", url }), "invalid_url");
  }
  await rejects(
    controller.request(SESSION_A, "browser_start_task", { title: "t", url: "not a url" }),
    "invalid_url",
  );
});

test("unknown methods and malformed params fail at the boundary", async () => {
  const { controller } = setup();
  await rejects(
    controller.request(SESSION_A, "Runtime.evaluate", { expression: "1" }),
    "unknown_method",
  );
  await rejects(
    controller.request(SESSION_A, "browser_task_status", { taskId: "nope" }),
    "invalid_params",
  );
  await rejects(
    controller.request(SESSION_A, "browser_start_task", null),
    "invalid_params",
  );
  await rejects(
    controller.request("not-a-uuid", "browser_task_status", { taskId: randomUUID() }),
    "invalid_session",
  );
});

test("tasks and tabs are scoped to their own session", async () => {
  const { controller } = setup();
  const { taskId, tabId } = await activeTask(controller, SESSION_A);
  await rejects(
    controller.request(SESSION_B, "browser_task_status", { taskId }),
    "not_found",
  );
  await rejects(
    controller.request(SESSION_B, "browser_state", { taskId, tabId }),
    "not_found",
  );
});

test("foreign tabs in the same group are rejected; closed tabs are revoked", async () => {
  const { controller, fx } = setup();
  const { taskId } = await activeTask(controller);
  const foreign = await fx.chrome.tabs.create({ url: "https://user.example", active: false, windowId: 1 });
  await fx.chrome.tabs.group({ tabIds: [foreign.id], groupId: 7 });
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId: foreign.id }),
    /tab_revoked|not_found/,
  );
  const { taskId: task2, tabId } = await activeTask(controller, SESSION_A, "second");
  fx.tabs.delete(tabId);
  fx.emit.removed(tabId);
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId: task2, tabId }),
    /tab_revoked|tab_closed/,
  );
});

test("a tab moved out of the group is detached, revoked, and stays revoked", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  fx.tabs.get(tabId).groupId = -1;
  fx.emit.updated(tabId, {}, { groupId: -1 });
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    "tab_revoked",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.attached.has(tabId), false);
  fx.tabs.get(tabId).groupId = 7;
  fx.emit.updated(tabId, {}, { groupId: 7 });
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    "tab_revoked",
  );
});

test("ungrouped events during open_tab setup do not revoke the tab", async () => {
  const fx = fakeChrome();
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId } = await activeTask(controller);
  const originalGroup = fx.chrome.tabs.group;
  fx.chrome.tabs.group = async (args) => {
    const gid = await originalGroup(args);
    for (const id of args.tabIds) {
      listenersFire(fx, id);
    }
    return gid;
  };
  function listenersFire(fixture, tabId) {
    fixture.emit.updated(tabId, {}, { groupId: -1 });
  }
  const result = await controller.request(SESSION_A, "browser_open_tab", {
    taskId, url: "https://example.com/two",
  });
  assert.equal(result.tabs.length, 2);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId: result.tabId });
  assert.ok(state.observationId);
});

test("debugger detach permanently revokes the tab and never reattaches", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  fx.attached.delete(tabId);
  fx.emit.detach(tabId);
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    "tab_revoked",
  );
  assert.equal(fx.attached.has(tabId), false);
});

test("pending task cannot be driven before approval", async () => {
  const { controller } = setup();
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId: started.taskId, tabId: 1 }),
    "task_pending",
  );
});

test("open_tab creates the tab in the task group's window", async () => {
  const { controller, fx } = setup({
    windows: [
      { id: 1, type: "normal", incognito: false },
      { id: 2, type: "normal", incognito: false },
    ],
  });
  const { taskId, tabId } = await activeTask(controller);
  fx.windows.splice(0, 1);
  fx.tabs.get(tabId).windowId = 2;
  fx.groups.get(7).windowId = 2;
  const result = await controller.request(SESSION_A, "browser_open_tab", {
    taskId, url: "https://example.com/two",
  });
  const tab = fx.tabs.get(result.tabId);
  assert.equal(tab.windowId, 2);
  assert.equal(tab.active, false);
  assert.equal(tab.groupId, result.groupId);
  assert.equal(result.tabs.length, 2);
  assert.ok(fx.attached.has(result.tabId));
});

test("a tab that starts pendingUrl commits before grouping and attach", async () => {
  const fx = fakeChrome();
  let commits = 0;
  const originalCreate = fx.chrome.tabs.create;
  fx.chrome.tabs.create = async (args) => {
    const tab = await originalCreate(args);
    const stored = fx.tabs.get(tab.id);
    stored.url = "";
    stored.pendingUrl = args.url;
    return { ...stored };
  };
  const originalGet = fx.chrome.tabs.get;
  fx.chrome.tabs.get = async (id) => {
    const info = await originalGet(id);
    const stored = fx.tabs.get(id);
    if (stored.pendingUrl) {
      commits += 1;
      if (commits > 2) {
        stored.url = stored.pendingUrl;
        delete stored.pendingUrl;
      }
      info.url = stored.url;
      info.pendingUrl = stored.pendingUrl;
    }
    return info;
  };
  let slept = 0;
  const controller = new BrowserController(fx.chrome, {
    sleep: async () => {
      slept += 1;
    },
  });
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com/",
  });
  const summary = await controller.approve(started.taskId);
  assert.equal(summary.status, "active");
  assert.equal(fx.groups.size, 1);
  assert.ok(slept >= 2);
});

test("stop during tab create never groups or attaches", async () => {
  const fx = fakeChrome();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const originalCreate = fx.chrome.tabs.create;
  fx.chrome.tabs.create = async (args) => {
    await gate;
    return originalCreate(args);
  };
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  const approving = controller.approve(started.taskId);
  await new Promise((resolve) => setImmediate(resolve));
  await controller.stop(started.taskId);
  release();
  const summary = await approving;
  assert.equal(summary.status, "stopped");
  assert.equal(fx.groups.size, 0);
  assert.equal(fx.attached.size, 0);
});

test("queued requests cannot run after stopAll marks the session ended", async () => {
  const { controller } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const slow = controller.request(SESSION_A, "browser_state", { taskId, tabId });
  const queued = controller.request(SESSION_A, "browser_start_task", {
    title: "late", url: "https://example.com",
  });
  const state2 = controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.stopAll();
  await rejects(slow, "session_ended");
  await rejects(queued, "session_ended");
  await rejects(state2, "session_ended");
  assert.equal(controller.listTasks().every((task) => task.status !== "pending"), true);
});

test("end_task detaches the debugger but leaves tabs and the group open", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const result = await controller.request(SESSION_A, "browser_end_task", { taskId });
  assert.equal(result.status, "stopped");
  assert.equal(fx.attached.has(tabId), false);
  assert.ok(fx.tabs.has(tabId));
  assert.equal(fx.tabs.get(tabId).groupId, result.groupId);
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    "task_stopped",
  );
});

test("stop during setup cannot resurrect a task", async () => {
  const fx = fakeChrome();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const originalAttach = fx.chrome.debugger.attach;
  fx.chrome.debugger.attach = async (target) => {
    await gate;
    return originalAttach(target);
  };
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const started = await controller.request(SESSION_A, "browser_start_task", {
    title: "t", url: "https://example.com",
  });
  const approving = controller.approve(started.taskId);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = controller.stop(started.taskId);
  release();
  await approving;
  await stopping;
  const status = await controller.request(SESSION_A, "browser_task_status", { taskId: started.taskId });
  assert.equal(status.status, "stopped");
  for (const tabId of fx.attached) {
    assert.fail(`tab ${tabId} still attached`);
  }
});

test("endSession revokes queued work for that session", async () => {
  const { controller } = setup();
  const { taskId, tabId } = await activeTask(controller);
  await controller.endSession(SESSION_A);
  await rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    "session_ended",
  );
  await rejects(
    controller.request(SESSION_A, "browser_start_task", { title: "t", url: "https://x.example" }),
    "session_ended",
  );
});

test("pending limit is 20 per session", async () => {
  const { controller } = setup();
  for (let i = 0; i < 20; i += 1) {
    await controller.request(SESSION_A, "browser_start_task", {
      title: `t${i}`, url: "https://example.com",
    });
  }
  await rejects(
    controller.request(SESSION_A, "browser_start_task", { title: "t21", url: "https://example.com" }),
    "pending_limit",
  );
});

test("type/key/scroll send only Input commands and validate params", async () => {
  const { controller, fx } = setup();
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.request(SESSION_A, "browser_press_key", {
    taskId, tabId, observationId: state.observationId, key: "Enter",
  });
  const keys = fx.sent.filter((c) => c.method === "Input.dispatchKeyEvent");
  assert.equal(keys[0].params.windowsVirtualKeyCode, 13);
  assert.equal(keys[0].params.text, "\r");
  assert.ok(!("nativeVirtualKeyCode" in keys[0].params));
  const s2 = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  for (const key of ["F5", "constructor", "toString", "hasOwnProperty"]) {
    await rejects(controller.request(SESSION_A, "browser_press_key", {
      taskId, tabId, observationId: s2.observationId, key,
    }), "invalid_params");
  }
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: s2.observationId, x: -1, y: 0,
  }), "invalid_params");
  const sEdge = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: sEdge.observationId, x: sEdge.screenshot.width, y: 0,
  }), "invalid_params");
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: randomUUID(), x: 5, y: 0,
  }), "stale_observation");
  const s2b = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.request(SESSION_A, "browser_scroll", {
    taskId, tabId, observationId: s2b.observationId, x: 10, y: 10, deltaX: 0, deltaY: 300,
  });
  const wheel = fx.sent.find((c) => c.params?.type === "mouseWheel");
  assert.equal(wheel.params.deltaY, 300);
  const s3 = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await controller.request(SESSION_A, "browser_type_text", {
    taskId, tabId, observationId: s3.observationId, text: "hello",
  });
  assert.ok(fx.sent.some((c) => c.method === "Input.insertText" && c.params.text === "hello"));
});

test("navigation between mousePressed and mouseReleased skips the release", async () => {
  const fx = fakeChrome();
  const originalSend = fx.chrome.debugger.sendCommand;
  fx.chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await originalSend(target, method, params);
    if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") {
      fx.emit.frameNavigated(target.tabId, "https://example.com/new-doc");
    }
    return result;
  };
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId, tabId } = await activeTask(controller);
  const state = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: state.observationId, x: 10, y: 10,
  }), "stale_observation");
  const mouse = fx.sent.filter((c) => c.method === "Input.dispatchMouseEvent");
  assert.equal(mouse.length, 1);
  assert.equal(mouse[0].params.type, "mousePressed");
});

test("a failed observation cannot be reused for input", async () => {
  const fx = fakeChrome();
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId, tabId } = await activeTask(controller);
  const good = await controller.request(SESSION_A, "browser_state", { taskId, tabId });
  const originalSend = fx.chrome.debugger.sendCommand;
  fx.chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === "Page.captureScreenshot") {
      throw new Error("capture failed");
    }
    return originalSend(target, method, params);
  };
  await assert.rejects(
    controller.request(SESSION_A, "browser_state", { taskId, tabId }),
    /capture failed/,
  );
  await rejects(controller.request(SESSION_A, "browser_click", {
    taskId, tabId, observationId: good.observationId, x: 1, y: 1,
  }), "stale_observation");
});

test("open_tab fails closed when the task group is gone", async () => {
  const { controller, fx } = setup();
  const { taskId } = await activeTask(controller);
  fx.groups.delete(7);
  await rejects(controller.request(SESSION_A, "browser_open_tab", {
    taskId, url: "https://example.com/more",
  }), "group_closed");
  assert.equal(fx.tabs.size, 1);
});

test("group mutated during a deferred attach revokes, detaches, and skips Page.enable", async () => {
  const fx = fakeChrome();
  const controller = new BrowserController(fx.chrome, { sleep: async () => {} });
  const { taskId } = await activeTask(controller);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const originalAttach = fx.chrome.debugger.attach;
  fx.chrome.debugger.attach = async (target) => {
    await gate;
    return originalAttach(target);
  };
  const opening = controller.request(SESSION_A, "browser_open_tab", {
    taskId, url: "https://example.com/two",
  });
  let newTab;
  for (let i = 0; i < 50 && !newTab; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    newTab = [...fx.tabs.values()].find((t) => t.url === "https://example.com/two");
  }
  newTab.groupId = -1;
  release();
  await rejects(opening, /tab_revoked|task_stopped|grouping_failed/);
  assert.equal(fx.attached.has(newTab.id), false);
  assert.ok(!fx.sent.some((c) => c.method === "Page.enable" && c.tabId === newTab.id));
});
