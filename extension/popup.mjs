export function initPopup({ document, chrome, setInterval: setIntervalFn }) {
  const statusEl = document.getElementById("status");
  const errorEl = document.getElementById("error");
  const connectBtn = document.getElementById("connect");
  const disconnectBtn = document.getElementById("disconnect");
  const refreshBtn = document.getElementById("refresh");
  const pendingList = document.getElementById("pending");
  const activeList = document.getElementById("active");
  const noPending = document.getElementById("no-pending");
  const noActive = document.getElementById("no-active");
  const autoApproveEl = document.getElementById("auto-approve");

  let lastRendered = "";
  let busy = false;
  let actionError = null;
  let autoApproveBusy = false;

  async function send(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) {
      throw new Error(reply?.error?.message || "The extension rejected the request.");
    }
    return reply.result;
  }

  function taskItem(task) {
    const item = document.createElement("li");
    const title = document.createElement("p");
    title.className = "task-title";
    title.textContent = task.title;
    item.append(title);
    if (task.url) {
      const url = document.createElement("p");
      url.className = "task-url";
      url.textContent = task.url;
      item.append(url);
    }
    if (task.error) {
      const error = document.createElement("p");
      error.className = "error";
      error.textContent = task.error;
      item.append(error);
    }
    const buttons = document.createElement("div");
    buttons.className = "task-buttons";
    const add = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        button.disabled = true;
        button.textContent = `${label}…`;
        actionError = null;
        handler()
          .catch((error) => {
            actionError = error;
          })
          .finally(() => {
            button.disabled = false;
            button.textContent = label;
            lastRendered = "";
            refresh();
          });
      });
      buttons.append(button);
    };
    if (task.status === "pending") {
      add("Allow", () => send({ type: "approve", taskId: task.taskId }));
      add("Deny", () => send({ type: "deny", taskId: task.taskId }));
    } else {
      const state = document.createElement("button");
      state.type = "button";
      state.disabled = true;
      state.textContent = task.status;
      buttons.append(state);
      if (task.status === "active" || task.status === "starting") {
        add("Stop", () => send({ type: "stop", taskId: task.taskId }));
      }
    }
    item.append(buttons);
    return item;
  }

  function render(state) {
    statusEl.textContent = state.connected ? "Connected" : "Disconnected";
    statusEl.className = `status ${state.connected ? "connected" : "disconnected"}`;
    connectBtn.disabled = state.connected;
    disconnectBtn.disabled = !state.connected;
    const connectionError = state.connected ? null : state.lastError;
    const shown = actionError || (connectionError ? new Error(connectionError) : null);
    errorEl.hidden = !shown;
    errorEl.textContent = shown ? shown.message : "";
    if (!autoApproveBusy) {
      autoApproveEl.checked = Boolean(state.autoApprove);
    }

    const key = JSON.stringify([state.connected, state.lastError, state.tasks]);
    if (key === lastRendered) {
      return;
    }
    lastRendered = key;
    pendingList.replaceChildren();
    activeList.replaceChildren();
    const pending = state.tasks.filter((task) => task.status === "pending");
    const running = state.tasks.filter((task) => task.status !== "pending");
    for (const task of pending) {
      pendingList.append(taskItem(task));
    }
    for (const task of running) {
      activeList.append(taskItem(task));
    }
    noPending.hidden = pending.length > 0;
    noActive.hidden = running.length > 0;
  }

  async function refresh() {
    if (busy) {
      return;
    }
    busy = true;
    try {
      render(await send({ type: "status" }));
    } catch (error) {
      actionError = error;
      errorEl.hidden = false;
      errorEl.textContent = error.message;
    } finally {
      busy = false;
    }
  }

  connectBtn.addEventListener("click", () => {
    connectBtn.disabled = true;
    actionError = null;
    send({ type: "connect" })
      .then(() => {
        connectBtn.disabled = false;
      })
      .catch((error) => {
        actionError = error;
        connectBtn.disabled = false;
      })
      .finally(refresh);
  });
  disconnectBtn.addEventListener("click", () => {
    disconnectBtn.disabled = true;
    actionError = null;
    send({ type: "disconnect" })
      .then(() => {
        disconnectBtn.disabled = false;
      })
      .catch((error) => {
        actionError = error;
        disconnectBtn.disabled = false;
      })
      .finally(refresh);
  });
  refreshBtn.addEventListener("click", refresh);
  autoApproveEl.addEventListener("change", () => {
    const enabled = autoApproveEl.checked;
    autoApproveEl.disabled = true;
    autoApproveBusy = true;
    actionError = null;
    send({ type: "set_auto_approve", enabled })
      .catch((error) => {
        autoApproveEl.checked = !enabled;
        actionError = error;
      })
      .finally(() => {
        autoApproveEl.disabled = false;
        autoApproveBusy = false;
        refresh();
      });
  });

  if (setIntervalFn) {
    setIntervalFn(refresh, 1000);
  }
  refresh();
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  initPopup({ document, chrome, setInterval });
}
