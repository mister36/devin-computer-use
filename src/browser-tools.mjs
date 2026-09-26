import { z } from "zod";

import { BrowserError } from "./browser-client.mjs";

const taskId = z.string().uuid()
  .describe("Task id returned by browser_start_task. Only task tabs are reachable; no other tabs or AX fallback exist.");
const tabId = z.number().int().positive()
  .describe("A tab id belonging to the task, from browser_task_status/browser_open_tab.");
const observationId = z.string().uuid()
  .describe("observationId from the most recent browser_state result for this tab.");
const url = z.string().refine((value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}, "http(s) URL only; no credentials or other schemes.")
  .describe("http(s) URL only; no credentials or other schemes.");
const coords = {
  x: z.number().describe("Horizontal coordinate in screenshot pixels (as returned by browser_state)."),
  y: z.number().describe("Vertical coordinate in screenshot pixels."),
};

const APPROVAL_NOTE = "The task runs inside the Devin Browser Tasks Chrome extension, where "
  + "the user approves each task unless they enabled the extension's auto-approve setting; "
  + "these tools never fall back to the desktop AX helper.";

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function errorResult(error) {
  const code = error instanceof BrowserError || error?.code ? error.code : "error";
  return textResult(`${code}: ${error.message}`, { isError: true });
}

function stateResult(state) {
  const { screenshot, ...rest } = state || {};
  const { png, ...meta } = screenshot || {};
  const content = [{
    type: "text",
    text: JSON.stringify(screenshot ? { ...rest, screenshot: meta } : rest, null, 2),
  }];
  if (png) {
    content.push({ type: "image", data: png, mimeType: "image/png" });
  }
  return { content };
}

export function createBrowserTools(client) {
  const call = async (method, params, { state = false } = {}) => {
    let result;
    try {
      result = await client.request(method, params);
    } catch (error) {
      return errorResult(error);
    }
    return state ? stateResult(result) : textResult(JSON.stringify(result, null, 2));
  };

  return [
    {
      name: "browser_start_task",
      description: `Start a Chrome browser task. If it returns status "active" with tabs, proceed directly; if it returns "pending", ask the user to approve it in the Devin Browser Tasks extension. ${APPROVAL_NOTE}`,
      inputSchema: {
        title: z.string().trim().min(1).max(80).describe("Short task title shown in the extension approval popup."),
        url,
      },
      handler: (params) => call("browser_start_task", params),
    },
    {
      name: "browser_task_status",
      description: `Check whether the user approved a browser task and list its owned tabs. ${APPROVAL_NOTE}`,
      inputSchema: { taskId },
      handler: (params) => call("browser_task_status", params),
    },
    {
      name: "browser_open_tab",
      description: `Open a new background tab inside an approved browser task's tab group. ${APPROVAL_NOTE}`,
      inputSchema: { taskId, url },
      handler: (params) => call("browser_open_tab", params),
    },
    {
      name: "browser_state",
      description: `Observe a task tab: viewport screenshot plus a bounded accessibility tree and an observationId required by input tools. ${APPROVAL_NOTE}`,
      inputSchema: { taskId, tabId },
      handler: (params) => call("browser_state", params, { state: true }),
    },
    {
      name: "browser_click",
      description: `Left-click a point in a task tab using screenshot pixel coordinates. Ask the user before actions that send, post, purchase or delete. ${APPROVAL_NOTE}`,
      inputSchema: { taskId, tabId, observationId, ...coords },
      handler: (params) => call("browser_click", params, { state: true }),
    },
    {
      name: "browser_type_text",
      description: `Insert text into the focused field of a task tab (focus it with browser_click first). Ask the user before sending messages. ${APPROVAL_NOTE}`,
      inputSchema: {
        taskId,
        tabId,
        observationId,
        text: z.string().max(20_000).describe("Text to insert; it does not select-all or submit."),
      },
      handler: (params) => call("browser_type_text", params, { state: true }),
    },
    {
      name: "browser_press_key",
      description: `Press one key (Enter, Tab, Escape, Backspace, Delete, arrows, Space) in a task tab. No browser shortcuts or modifiers. Enter can submit forms — ask the user before sending or posting. ${APPROVAL_NOTE}`,
      inputSchema: {
        taskId,
        tabId,
        observationId,
        key: z.enum([
          "Enter", "Tab", "Escape", "Backspace", "Delete",
          "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space",
        ]),
      },
      handler: (params) => call("browser_press_key", params, { state: true }),
    },
    {
      name: "browser_scroll",
      description: `Scroll a task tab at a point (screenshot pixels) by CSS-pixel deltas; positive deltaY scrolls down. ${APPROVAL_NOTE}`,
      inputSchema: {
        taskId,
        tabId,
        observationId,
        ...coords,
        deltaX: z.number().describe("Horizontal scroll delta in CSS pixels."),
        deltaY: z.number().describe("Vertical scroll delta in CSS pixels; positive scrolls down."),
      },
      handler: (params) => call("browser_scroll", params, { state: true }),
    },
    {
      name: "browser_navigate",
      description: `Navigate a task tab to a new http(s) URL, then return a fresh observation. ${APPROVAL_NOTE}`,
      inputSchema: { taskId, tabId, url },
      handler: (params) => call("browser_navigate", params, { state: true }),
    },
    {
      name: "browser_end_task",
      description: `Release control of a browser task; its tabs and named tab group stay open for the user. ${APPROVAL_NOTE}`,
      inputSchema: { taskId },
      handler: (params) => call("browser_end_task", params),
    },
  ];
}
