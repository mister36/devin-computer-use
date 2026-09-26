import { BrowserController, BrowserTaskError } from "./controller.mjs";

export function registerBackground(chromeApi, controller = new BrowserController(chromeApi)) {
  let port = null;
  let lastError = null;
  const settingsReady = chromeApi.storage.local.get("autoApprove").then(
    (s) => controller.setAutoApprove(s?.autoApprove === true),
    () => {},
  );

  function updateBadge() {
    const tasks = controller.listTasks();
    const pending = tasks.filter((task) => task.status === "pending").length;
    const active = tasks.some((task) => task.status === "active" || task.status === "starting");
    chromeApi.action.setBadgeBackgroundColor({ color: pending ? "#d97706" : "#2563eb" });
    chromeApi.action.setBadgeText({ text: pending ? String(pending) : (active ? "●" : "") });
  }

  function dropPort(target) {
    if (target !== port) {
      try {
        target?.disconnect();
      } catch {
      }
      return;
    }
    port = null;
    try {
      target?.disconnect();
    } catch {
    }
    controller.stopAll().finally(updateBadge);
  }

  function post(target, message) {
    if (target !== port) {
      return;
    }
    try {
      target.postMessage(message);
    } catch {
      dropPort(target);
    }
  }

  function onNativeMessage(target, message) {
    if (!message || typeof message !== "object" || target !== port) {
      return;
    }
    if (message.method === "session_end" && typeof message.sessionId === "string") {
      settingsReady.then(() => controller.endSession(message.sessionId)).finally(updateBadge);
      return;
    }
    if (typeof message.id !== "string" || typeof message.method !== "string") {
      return;
    }
    settingsReady
      .then(() => controller.request(message.sessionId, message.method, message.params ?? {}))
      .then(
        (result) => post(target, { id: message.id, result }),
        (error) => post(target, {
          id: message.id,
          error: { code: error.code || "error", message: error.message || String(error) },
        }),
      )
      .finally(updateBadge);
  }

  function onNativeDisconnect(target) {
    const error = chromeApi.runtime.lastError?.message;
    if (target !== port) {
      return;
    }
    lastError = error || "The native host disconnected.";
    port = null;
    controller.stopAll().finally(updateBadge);
  }

  function connect() {
    if (port) {
      return true;
    }
    lastError = null;
    let opened;
    try {
      opened = chromeApi.runtime.connectNative("ai.devin.browser");
    } catch (error) {
      lastError = error.message;
      return false;
    }
    port = opened;
    opened.onMessage.addListener((message) => onNativeMessage(opened, message));
    opened.onDisconnect.addListener(() => onNativeDisconnect(opened));
    return true;
  }

  function disconnect() {
    const current = port;
    port = null;
    controller.stopAll().finally(updateBadge);
    try {
      current?.disconnect();
    } catch {
    }
  }

  function isPopupSender(sender) {
    return sender.id === chromeApi.runtime.id
      && sender.url === chromeApi.runtime.getURL("popup.html")
      && !sender.tab;
  }

  chromeApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || !isPopupSender(sender)) {
      return false;
    }
    const respond = (work) => {
      Promise.resolve(work).then(
        (result) => sendResponse({ ok: true, result: result ?? null }),
        (error) => sendResponse({
          ok: false,
          error: { code: error.code || "error", message: error.message || String(error) },
        }),
      );
      return true;
    };
    const requirePort = () => {
      if (!port) {
        throw new BrowserTaskError("browser_unavailable", "Press Connect first; the native host is not connected.");
      }
    };
    switch (message.type) {
      case "connect":
        return respond((async () => ({ connected: connect(), lastError }))());
      case "disconnect":
        return respond((async () => {
          disconnect();
          return { connected: false };
        })());
      case "approve":
        return respond((async () => {
          requirePort();
          const summary = await controller.approve(message.taskId);
          updateBadge();
          return summary;
        })());
      case "deny":
      case "stop":
        return respond((async () => {
          requirePort();
          const summary = await controller.stop(message.taskId);
          updateBadge();
          return summary;
        })());
      case "set_auto_approve":
        return respond((async () => {
          if (typeof message.enabled !== "boolean") {
            throw new BrowserTaskError("invalid_params", "enabled must be a boolean.");
          }
          await chromeApi.storage.local.set({ autoApprove: message.enabled });
          controller.setAutoApprove(message.enabled);
          return { autoApprove: message.enabled };
        })());
      case "status":
        return respond(settingsReady.then(() => ({
          connected: Boolean(port),
          lastError,
          tasks: controller.listTasks(),
          autoApprove: controller.autoApprove,
        })));
      default:
        return respond(Promise.reject(
          new BrowserTaskError("unknown_message", `Unknown popup message "${message.type}".`),
        ));
    }
  });

  updateBadge();
  return { controller, connect, disconnect };
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  registerBackground(chrome);
}
