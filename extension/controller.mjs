const MAX_PENDING_PER_SESSION = 20;
const MAX_TREE_NODES = 600;
const MAX_TEXT_LENGTH = 200;
const MAX_INPUT_TEXT = 20_000;
const MAX_SCREENSHOT_EDGE = 1280;
const SCREENSHOT_TOLERANCE = 1;
const DEFAULT_SETTLE_MS = 100;
const COMMIT_WAIT_ATTEMPTS = 50;
const COMMIT_WAIT_MS = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KEYS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export class BrowserTaskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BrowserTaskError";
    this.code = code;
  }
}

function normalizeUrl(value) {
  if (typeof value !== "string" || !value) {
    throw new BrowserTaskError("invalid_params", "url must be a non-empty string.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserTaskError("invalid_url", `"${value}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserTaskError("invalid_url", "Only http and https URLs can be controlled.");
  }
  if (url.username || url.password) {
    throw new BrowserTaskError("invalid_url", "URLs with embedded credentials are not allowed.");
  }
  return url.href;
}

function isHttpUrl(value) {
  try {
    return new URL(value).protocol === "http:" || new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new BrowserTaskError("invalid_params", `${field} must be a UUID.`);
  }
  return value;
}

function requireTabId(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BrowserTaskError("invalid_params", "tabId must be a positive integer.");
  }
  return value;
}

function requireFinite(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrowserTaskError("invalid_params", `${field} must be a finite number.`);
  }
  return value;
}

function pngSize(base64) {
  let bytes;
  try {
    bytes = atob(base64.slice(0, 64));
  } catch {
    throw new BrowserTaskError("screenshot_invalid", "The captured screenshot was not a PNG image.");
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33
      || !signature.every((byte, index) => bytes.charCodeAt(index) === byte)
      || bytes.slice(12, 16) !== "IHDR") {
    throw new BrowserTaskError("screenshot_invalid", "The captured screenshot was not a PNG image.");
  }
  const be32 = (offset) => (bytes.charCodeAt(offset) * 0x1000000)
    + (bytes.charCodeAt(offset + 1) << 16)
    + (bytes.charCodeAt(offset + 2) << 8)
    + bytes.charCodeAt(offset + 3);
  const width = be32(16);
  const height = be32(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new BrowserTaskError("screenshot_invalid", "The screenshot had invalid PNG dimensions.");
  }
  return { width, height };
}

function clip(value) {
  const text = String(value ?? "");
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text;
}

function buildTree(nodes) {
  const tree = [];
  for (const node of nodes || []) {
    if (tree.length >= MAX_TREE_NODES) {
      break;
    }
    const role = node.role?.value;
    if (!role || role === "none" || (role === "generic" && !node.name?.value)) {
      continue;
    }
    const entry = { role: clip(role), name: clip(node.name?.value) };
    const value = node.value?.value;
    if (value !== undefined && value !== null && value !== "") {
      entry.value = clip(value);
    }
    tree.push(entry);
  }
  return tree;
}

export class BrowserController {
  #chrome;
  #uuid;
  #sleep;
  #tasks = new Map();
  #tabOwners = new Map();
  #knownSessions = new Set();
  #endedSessions = new Set();
  #queue = Promise.resolve();
  #autoApprove = false;

  constructor(chrome, {
    uuid = () => crypto.randomUUID(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    this.#chrome = chrome;
    this.#uuid = uuid;
    this.#sleep = sleep;
    chrome.tabs.onRemoved.addListener((tabId) => this.#onTabRemoved(tabId));
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      this.#onTabUpdated(tabId, changeInfo, tab);
    });
    chrome.debugger.onDetach.addListener((source) => this.#onDebuggerDetach(source?.tabId));
    chrome.debugger.onEvent.addListener((source, method, params) => {
      this.#onDebuggerEvent(source?.tabId, method, params);
    });
  }

  request(sessionId, method, params = {}) {
    if (typeof sessionId !== "string" || !UUID_RE.test(sessionId)) {
      return Promise.reject(new BrowserTaskError("invalid_session", "Missing or invalid session id."));
    }
    if (typeof method !== "string" || !METHODS.has(method)) {
      return Promise.reject(new BrowserTaskError("unknown_method", `Unknown browser method "${method}".`));
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return Promise.reject(new BrowserTaskError("invalid_params", "params must be an object."));
    }
    this.#knownSessions.add(sessionId);
    return this.#enqueue(() => this.#dispatch(sessionId, method, params));
  }

  setAutoApprove(enabled) {
    this.#autoApprove = enabled === true;
  }

  get autoApprove() {
    return this.#autoApprove;
  }

  listTasks() {
    return [...this.#tasks.values()].map((task) => ({
      taskId: task.taskId,
      title: task.title,
      url: task.url,
      status: task.status,
      ...(task.error ? { error: task.error } : {}),
    }));
  }

  async approve(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task || task.status !== "pending") {
      throw new BrowserTaskError("not_found", "That task is not waiting for approval.");
    }
    task.status = "starting";
    try {
      await this.#addTab(task, task.url);
      if (task.status !== "starting") {
        throw new BrowserTaskError("task_stopped", "The task was stopped during setup.");
      }
      task.status = "active";
    } catch (error) {
      if (task.status === "starting") {
        task.status = "failed";
        task.error = error.message;
      }
      await this.#detachAll(task);
      this.#revokeTabs(task);
      return this.#summary(task);
    }
    return this.#summary(task);
  }

  async stop(taskId) {
    const task = this.#tasks.get(taskId);
    if (!task || task.status === "stopped") {
      return task ? this.#summary(task) : null;
    }
    task.status = "stopped";
    this.#revokeTabs(task);
    await this.#detachAll(task);
    return this.#summary(task);
  }

  async endSession(sessionId) {
    this.#endedSessions.add(sessionId);
    const tasks = [...this.#tasks.values()].filter((task) => task.sessionId === sessionId);
    await Promise.all(tasks.map((task) => this.stop(task.taskId)));
  }

  async stopAll() {
    for (const sessionId of this.#knownSessions) {
      this.#endedSessions.add(sessionId);
    }
    const tasks = [...this.#tasks.values()];
    for (const task of tasks) {
      task.status = "stopped";
      this.#revokeTabs(task);
    }
    await Promise.all(tasks.map((task) => this.#detachAll(task)));
  }

  #enqueue(job) {
    const run = this.#queue.then(job, job);
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  #dispatch(sessionId, method, params) {
    if (this.#endedSessions.has(sessionId)) {
      throw new BrowserTaskError("session_ended", "This browser session ended. Reconnect the extension and start a new task.");
    }
    switch (method) {
      case "browser_start_task": return this.#startTask(sessionId, params);
      case "browser_task_status": return this.#taskStatus(sessionId, params);
      case "browser_open_tab": return this.#openTab(sessionId, params);
      case "browser_state": return this.#state(sessionId, params);
      case "browser_click": return this.#click(sessionId, params);
      case "browser_type_text": return this.#typeText(sessionId, params);
      case "browser_press_key": return this.#pressKey(sessionId, params);
      case "browser_scroll": return this.#scroll(sessionId, params);
      case "browser_navigate": return this.#navigate(sessionId, params);
      case "browser_end_task": return this.#endTask(sessionId, params);
      default: throw new BrowserTaskError("unknown_method", `Unknown browser method "${method}".`);
    }
  }

  #ownTask(sessionId, taskId, { active = false } = {}) {
    requireUuid(taskId, "taskId");
    const task = this.#tasks.get(taskId);
    if (!task || task.sessionId !== sessionId) {
      throw new BrowserTaskError("not_found", "Unknown taskId for this session.");
    }
    if (active && task.status !== "active") {
      if (task.status === "pending") {
        throw new BrowserTaskError("task_pending", "Approve this task in the Devin Browser Tasks extension first.");
      }
      throw new BrowserTaskError("task_stopped", `Task "${task.title}" is ${task.status}.`);
    }
    return task;
  }

  #assertLive(task, record) {
    if (this.#endedSessions.has(task.sessionId)) {
      throw new BrowserTaskError("session_ended", "This browser session ended.");
    }
    if (task.status !== "starting" && task.status !== "active") {
      throw new BrowserTaskError("task_stopped", `Task "${task.title}" is ${task.status}.`);
    }
    if (record) {
      const owner = this.#tabOwners.get(record.tabId);
      if (record.revoked || !owner || owner.task !== task) {
        throw new BrowserTaskError("tab_revoked", "That tab is no longer under Devin's control.");
      }
    }
  }

  async #guardTab(task, tabId) {
    requireTabId(tabId);
    const record = task.tabs.get(tabId);
    this.#assertLive(task, record);
    if (!record || !record.grouped) {
      throw new BrowserTaskError("not_found", "That tab is not part of this task.");
    }
    let info;
    try {
      info = await this.#chrome.tabs.get(tabId);
    } catch {
      record.revoked = true;
      throw new BrowserTaskError("tab_closed", "The task tab was closed.");
    }
    this.#assertLive(task, record);
    if (typeof info.url === "string" && info.url !== record.url) {
      record.url = info.url;
      record.epoch += 1;
      record.observation = null;
    }
    if (info.groupId !== task.groupId) {
      this.#revokeTab(record);
      throw new BrowserTaskError("tab_revoked", "The tab left the Devin task group; control was released.");
    }
    if (!isHttpUrl(info.url)) {
      throw new BrowserTaskError("invalid_url", `The tab navigated to ${info.url || "a URL"} which cannot be controlled.`);
    }
    if (!record.attached) {
      throw new BrowserTaskError("debugger_detached", "The debugger detached from the task tab; control was released.");
    }
    this.#assertLive(task, record);
    return { record, info };
  }

  async #command(task, record, method, params, expectedEpoch) {
    await this.#guardTab(task, record.tabId);
    if (expectedEpoch !== undefined && record.epoch !== expectedEpoch) {
      throw new BrowserTaskError("stale_observation", "The page navigated before the action could run. Observe again.");
    }
    return this.#chrome.debugger.sendCommand({ tabId: record.tabId }, method, params);
  }

  async #normalWindowId() {
    let windows;
    try {
      windows = await this.#chrome.windows.getAll({ windowTypes: ["normal"] });
    } catch {
      windows = null;
    }
    const window = (windows || []).find((candidate) => candidate.type === "normal" && !candidate.incognito);
    if (!window) {
      throw new BrowserTaskError("no_window", "Chrome has no open normal window. Open a Chrome window and try again.");
    }
    return window.id;
  }

  async #taskWindowId(task) {
    if (task.groupId == null) {
      return this.#normalWindowId();
    }
    let group;
    try {
      group = await this.#chrome.tabGroups.get(task.groupId);
    } catch {
    }
    if (!group || !Number.isInteger(group.windowId)) {
      throw new BrowserTaskError("group_closed", "The task tab group no longer exists. Start a new task.");
    }
    return group.windowId;
  }

  async #awaitCommittedUrl(task, record) {
    for (let attempt = 0; attempt < COMMIT_WAIT_ATTEMPTS; attempt += 1) {
      this.#assertLive(task, record);
      let info;
      try {
        info = await this.#chrome.tabs.get(record.tabId);
      } catch {
        record.revoked = true;
        throw new BrowserTaskError("tab_closed", "The task tab was closed during setup.");
      }
      if (isHttpUrl(info.url)) {
        if (info.url !== record.url) {
          record.url = info.url;
          record.epoch += 1;
        }
        return info;
      }
      await this.#sleep(COMMIT_WAIT_MS);
    }
    throw new BrowserTaskError("page_loading", "The task tab did not finish loading an http(s) page in time.");
  }

  async #addTab(task, url) {
    const chrome = this.#chrome;
    const windowId = await this.#taskWindowId(task);
    this.#assertLive(task);
    let created;
    try {
      created = await chrome.tabs.create({ url, active: false, windowId });
    } catch (error) {
      throw new BrowserTaskError(
        "no_window",
        `Could not create a task tab (${error.message}). Open a Chrome window and try again.`,
      );
    }
    const record = {
      tabId: created.id,
      url: created.url || url,
      title: "",
      attached: false,
      revoked: false,
      grouped: false,
      epoch: 0,
      observation: null,
    };
    task.tabs.set(record.tabId, record);
    this.#tabOwners.set(record.tabId, { task, record });
    try {
      this.#assertLive(task, record);
      await this.#awaitCommittedUrl(task, record);
      this.#assertLive(task, record);
      if (task.groupId == null) {
        task.groupId = await chrome.tabs.group({ tabIds: [record.tabId] });
        this.#assertLive(task, record);
        await chrome.tabGroups.update(task.groupId, {
          title: `Devin — ${task.title}`,
          color: "blue",
        });
      } else {
        await chrome.tabs.group({ tabIds: [record.tabId], groupId: task.groupId });
      }
      this.#assertLive(task, record);
      const grouped = await chrome.tabs.get(record.tabId).catch(() => null);
      if (!grouped || grouped.groupId !== task.groupId) {
        record.revoked = true;
        throw new BrowserTaskError("grouping_failed", "Chrome did not keep the new tab inside the task group.");
      }
      record.grouped = true;
      this.#assertLive(task, record);
      try {
        await chrome.debugger.attach({ tabId: record.tabId }, "1.3");
      } catch (error) {
        throw new BrowserTaskError(
          "debugger_unavailable",
          `Could not attach the Devin debugger to the task tab (${error.message}). `
            + "Close other DevTools sessions on that tab.",
        );
      }
      record.attached = true;
      this.#assertLive(task, record);
      await this.#command(task, record, "Page.enable");
      this.#assertLive(task, record);
    } catch (error) {
      record.revoked = true;
      if (record.attached) {
        record.attached = false;
        await chrome.debugger.detach({ tabId: record.tabId }).catch(() => {});
      }
      throw error;
    }
    return record;
  }

  #summary(task) {
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      groupId: task.groupId ?? null,
      tabs: [...task.tabs.values()]
        .filter((record) => !record.revoked && record.grouped)
        .map((record) => ({ tabId: record.tabId, url: record.url, title: record.title })),
      ...(task.error ? { error: task.error } : {}),
    };
  }

  #revokeTab(record) {
    record.revoked = true;
    record.observation = null;
    if (record.attached) {
      record.attached = false;
      this.#chrome.debugger.detach({ tabId: record.tabId }).catch(() => {});
    }
    this.#tabOwners.delete(record.tabId);
  }

  #revokeTabs(task) {
    for (const record of task.tabs.values()) {
      record.revoked = true;
      record.observation = null;
      this.#tabOwners.delete(record.tabId);
    }
  }

  async #detachAll(task) {
    for (const record of task.tabs.values()) {
      if (record.attached) {
        record.attached = false;
        await this.#chrome.debugger.detach({ tabId: record.tabId }).catch(() => {});
      }
    }
  }

  #onTabRemoved(tabId) {
    const owner = this.#tabOwners.get(tabId);
    if (!owner) {
      return;
    }
    owner.record.revoked = true;
    owner.record.attached = false;
    owner.record.observation = null;
    this.#tabOwners.delete(tabId);
  }

  #onTabUpdated(tabId, changeInfo, tab) {
    const owner = this.#tabOwners.get(tabId);
    if (!owner) {
      return;
    }
    const { task, record } = owner;
    const groupId = tab?.groupId ?? changeInfo?.groupId;
    if (record.grouped && typeof groupId === "number"
        && task.groupId != null && groupId !== task.groupId) {
      this.#revokeTab(record);
      return;
    }
    if (typeof changeInfo?.url === "string" && changeInfo.url !== record.url) {
      record.url = changeInfo.url;
      record.epoch += 1;
      record.observation = null;
    }
    if (typeof changeInfo?.title === "string") {
      record.title = changeInfo.title;
    }
    if (typeof tab?.title === "string") {
      record.title = tab.title;
    }
  }

  #onDebuggerDetach(tabId) {
    const owner = this.#tabOwners.get(tabId);
    if (!owner) {
      return;
    }
    this.#revokeTab(owner.record);
  }

  #onDebuggerEvent(tabId, method, params) {
    const owner = this.#tabOwners.get(tabId);
    if (!owner) {
      return;
    }
    if (method === "Page.frameNavigated") {
      const frame = params?.frame;
      if (!frame || frame.parentId) {
        return;
      }
      owner.record.epoch += 1;
      owner.record.observation = null;
      if (typeof frame.url === "string") {
        owner.record.url = frame.url;
      }
      return;
    }
    if (method === "Page.navigatedWithinDocument") {
      owner.record.epoch += 1;
      owner.record.observation = null;
      if (typeof params?.url === "string") {
        owner.record.url = params.url;
      }
    }
  }

  #takeObservation(task, record, observationId) {
    requireUuid(observationId, "observationId");
    const observation = record.observation;
    if (!observation || observation.observationId !== observationId
        || observation.epoch !== record.epoch || observation.url !== record.url) {
      throw new BrowserTaskError(
        "stale_observation",
        "That observation is stale. Call browser_state again before acting.",
      );
    }
    record.observation = null;
    return observation;
  }

  async #capture(task, record, viewport, clipScale) {
    const shot = await this.#command(task, record, "Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: clipScale,
      },
    });
    const size = pngSize(shot.data);
    const edge = Math.max(size.width, size.height);
    if (edge > MAX_SCREENSHOT_EDGE + SCREENSHOT_TOLERANCE) {
      const retry = clipScale * (MAX_SCREENSHOT_EDGE / edge);
      const second = await this.#command(task, record, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: retry,
        },
      });
      const resized = pngSize(second.data);
      if (Math.max(resized.width, resized.height) > MAX_SCREENSHOT_EDGE + SCREENSHOT_TOLERANCE) {
        throw new BrowserTaskError("screenshot_invalid", "Chrome returned an oversized screenshot twice.");
      }
      return { data: second.data, size: resized };
    }
    return { data: shot.data, size };
  }

  async #observe(task, tabId) {
    const { record } = await this.#guardTab(task, tabId);
    record.observation = null;
    const epoch = record.epoch;
    const url = record.url;
    const metrics = await this.#command(task, record, "Page.getLayoutMetrics");
    const viewport = metrics?.cssVisualViewport;
    if (!viewport
        || !Number.isFinite(viewport.clientWidth) || viewport.clientWidth <= 0
        || !Number.isFinite(viewport.clientHeight) || viewport.clientHeight <= 0) {
      throw new BrowserTaskError("state_failed", "Chrome did not return layout metrics for the task tab.");
    }
    const clipScale = Math.min(
      1,
      MAX_SCREENSHOT_EDGE / Math.max(viewport.clientWidth, viewport.clientHeight),
    );
    const shot = await this.#capture(task, record, viewport, clipScale);
    const ax = await this.#command(task, record, "Accessibility.getFullAXTree");
    const tree = buildTree(ax.nodes);
    await this.#guardTab(task, tabId);
    if (record.epoch !== epoch || record.url !== url) {
      throw new BrowserTaskError("stale_observation", "The page navigated while capturing. Observe again.");
    }
    const scaleX = shot.size.width / viewport.clientWidth;
    const scaleY = shot.size.height / viewport.clientHeight;
    const observationId = this.#uuid();
    record.observation = {
      observationId,
      epoch,
      scaleX,
      scaleY,
      width: shot.size.width,
      height: shot.size.height,
      url: record.url,
    };
    return {
      taskId: task.taskId,
      tabId,
      groupId: task.groupId,
      url: record.url,
      title: record.title,
      observationId,
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: scaleX,
        scaleY,
      },
      tree,
      screenshot: {
        png: shot.data,
        width: shot.size.width,
        height: shot.size.height,
        scale: scaleX,
        scaleY,
      },
    };
  }

  async #afterAction(task, tabId) {
    await this.#sleep(DEFAULT_SETTLE_MS);
    this.#assertLive(task, task.tabs.get(tabId));
    return this.#observe(task, tabId);
  }

  async #startTask(sessionId, { title, url }) {
    if (typeof title !== "string" || !title.trim() || title.trim().length > 80) {
      throw new BrowserTaskError("invalid_params", "title must be 1–80 characters.");
    }
    const target = normalizeUrl(url);
    const pending = [...this.#tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.status === "pending");
    if (pending.length >= MAX_PENDING_PER_SESSION) {
      throw new BrowserTaskError(
        "pending_limit",
        "Too many tasks are waiting for approval. Approve or deny them in the extension first.",
      );
    }
    const task = {
      taskId: this.#uuid(),
      sessionId,
      title: title.trim(),
      url: target,
      status: "pending",
      groupId: null,
      tabs: new Map(),
      error: null,
    };
    this.#tasks.set(task.taskId, task);
    if (this.#autoApprove) {
      return this.approve(task.taskId);
    }
    return {
      taskId: task.taskId,
      status: "pending",
      message: "Approve this task in the Devin Browser Tasks extension.",
    };
  }

  async #taskStatus(sessionId, { taskId }) {
    const task = this.#ownTask(sessionId, taskId);
    return this.#summary(task);
  }

  async #openTab(sessionId, { taskId, url }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const target = normalizeUrl(url);
    const record = await this.#addTab(task, target);
    if (task.status !== "active") {
      record.revoked = true;
      if (record.attached) {
        record.attached = false;
        await this.#chrome.debugger.detach({ tabId: record.tabId }).catch(() => {});
      }
      throw new BrowserTaskError("task_stopped", "The task was stopped while opening the tab.");
    }
    return { tabId: record.tabId, ...this.#summary(task) };
  }

  async #state(sessionId, { taskId, tabId }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    return this.#observe(task, tabId);
  }

  async #click(sessionId, { taskId, tabId, observationId, x, y }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const { record } = await this.#guardTab(task, tabId);
    const px = requireFinite(x, "x");
    const py = requireFinite(y, "y");
    const observation = this.#takeObservation(task, record, observationId);
    if (px < 0 || py < 0 || px >= observation.width || py >= observation.height) {
      throw new BrowserTaskError("invalid_params", "x,y must be inside the last screenshot.");
    }
    const cx = px / observation.scaleX;
    const cy = py / observation.scaleY;
    const epoch = observation.epoch;
    await this.#command(task, record, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
    }, epoch);
    await this.#command(task, record, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
    }, epoch);
    return this.#afterAction(task, tabId);
  }

  async #typeText(sessionId, { taskId, tabId, observationId, text }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const { record } = await this.#guardTab(task, tabId);
    if (typeof text !== "string" || text.length > MAX_INPUT_TEXT) {
      throw new BrowserTaskError("invalid_params", "text must be a string of at most 20000 characters.");
    }
    const observation = this.#takeObservation(task, record, observationId);
    await this.#command(task, record, "Input.insertText", { text }, observation.epoch);
    return this.#afterAction(task, tabId);
  }

  async #pressKey(sessionId, { taskId, tabId, observationId, key }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const { record } = await this.#guardTab(task, tabId);
    if (typeof key !== "string" || !Object.hasOwn(KEYS, key)) {
      throw new BrowserTaskError(
        "invalid_params",
        `Unsupported key "${key}". Allowed: ${Object.keys(KEYS).join(", ")}.`,
      );
    }
    const spec = KEYS[key];
    const observation = this.#takeObservation(task, record, observationId);
    const down = {
      type: "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    };
    if (spec.text) {
      down.text = spec.text;
    }
    await this.#command(task, record, "Input.dispatchKeyEvent", down, observation.epoch);
    await this.#command(task, record, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    }, observation.epoch);
    return this.#afterAction(task, tabId);
  }

  async #scroll(sessionId, { taskId, tabId, observationId, x, y, deltaX, deltaY }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const { record } = await this.#guardTab(task, tabId);
    const px = requireFinite(x, "x");
    const py = requireFinite(y, "y");
    const dx = requireFinite(deltaX, "deltaX");
    const dy = requireFinite(deltaY, "deltaY");
    const observation = this.#takeObservation(task, record, observationId);
    if (px < 0 || py < 0 || px >= observation.width || py >= observation.height) {
      throw new BrowserTaskError("invalid_params", "x,y must be inside the last screenshot.");
    }
    await this.#command(task, record, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: px / observation.scaleX,
      y: py / observation.scaleY,
      deltaX: dx,
      deltaY: dy,
    }, observation.epoch);
    return this.#afterAction(task, tabId);
  }

  async #navigate(sessionId, { taskId, tabId, url }) {
    const task = this.#ownTask(sessionId, taskId, { active: true });
    const { record } = await this.#guardTab(task, tabId);
    const target = normalizeUrl(url);
    record.epoch += 1;
    record.observation = null;
    const result = await this.#command(task, record, "Page.navigate", { url: target });
    if (result?.errorText || result?.isDownload) {
      throw new BrowserTaskError(
        "navigation_failed",
        `Navigation to ${target} failed${result.errorText ? `: ${result.errorText}` : " (download started)"}.`,
      );
    }
    const loaderId = result?.loaderId;
    for (let attempt = 0; attempt < COMMIT_WAIT_ATTEMPTS; attempt += 1) {
      this.#assertLive(task, record);
      if (loaderId) {
        const tree = await this.#command(task, record, "Page.getFrameTree");
        if (tree?.frameTree?.frame?.loaderId === loaderId) {
          return this.#afterAction(task, tabId);
        }
      } else {
        const info = await this.#chrome.tabs.get(record.tabId).catch(() => null);
        const committed = info?.url || record.url;
        if (committed === target) {
          return this.#afterAction(task, tabId);
        }
      }
      await this.#sleep(COMMIT_WAIT_MS);
    }
    throw new BrowserTaskError("page_loading", `Navigation to ${target} did not commit in time.`);
  }

  async #endTask(sessionId, { taskId }) {
    const task = this.#ownTask(sessionId, taskId);
    task.status = "stopped";
    this.#revokeTabs(task);
    await this.#detachAll(task);
    return { ...this.#summary(task), message: "Task ended; its tabs and tab group were left open." };
  }
}

const METHODS = new Set([
  "browser_start_task",
  "browser_task_status",
  "browser_open_tab",
  "browser_state",
  "browser_click",
  "browser_type_text",
  "browser_press_key",
  "browser_scroll",
  "browser_navigate",
  "browser_end_task",
]);
