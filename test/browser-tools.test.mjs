import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { z } from "zod";

import { BrowserError } from "../src/browser-client.mjs";
import { createBrowserTools } from "../src/browser-tools.mjs";

const PNG = "aGVsbG8=";

function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (handlers[method]) {
        return handlers[method](params);
      }
      return { ok: true };
    },
  };
}

const tool = (tools, name) => tools.find((t) => t.name === name);
const state = () => ({
  taskId: randomUUID(),
  tabId: 5,
  url: "https://example.com",
  observationId: randomUUID(),
  tree: [{ role: "button", name: "OK" }],
  screenshot: { png: PNG, width: 500, height: 400, scale: 1 },
});

test("exposes the full browser_* surface", () => {
  const names = createBrowserTools(fakeClient()).map((t) => t.name).sort();
  assert.deepEqual(names, [
    "browser_click",
    "browser_end_task",
    "browser_navigate",
    "browser_open_tab",
    "browser_press_key",
    "browser_scroll",
    "browser_start_task",
    "browser_state",
    "browser_task_status",
    "browser_type_text",
  ]);
});

test("every tool routes params to the matching method", async () => {
  const client = fakeClient({ browser_state: () => state(), browser_click: () => state() });
  const tools = createBrowserTools(client);
  const taskId = randomUUID();
  const observationId = randomUUID();
  await tool(tools, "browser_start_task").handler({ title: "t", url: "https://x.example" });
  await tool(tools, "browser_task_status").handler({ taskId });
  await tool(tools, "browser_open_tab").handler({ taskId, url: "https://x.example/2" });
  await tool(tools, "browser_state").handler({ taskId, tabId: 5 });
  await tool(tools, "browser_click").handler({ taskId, tabId: 5, observationId, x: 1, y: 2 });
  await tool(tools, "browser_type_text").handler({ taskId, tabId: 5, observationId, text: "hi" });
  await tool(tools, "browser_press_key").handler({ taskId, tabId: 5, observationId, key: "Enter" });
  await tool(tools, "browser_scroll").handler({
    taskId, tabId: 5, observationId, x: 0, y: 0, deltaX: 0, deltaY: 10,
  });
  await tool(tools, "browser_navigate").handler({ taskId, tabId: 5, url: "https://x.example/3" });
  await tool(tools, "browser_end_task").handler({ taskId });
  assert.deepEqual(client.calls.map((c) => c.method), [
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
  assert.deepEqual(client.calls[4].params, { taskId, tabId: 5, observationId, x: 1, y: 2 });
});

test("state results split screenshot out of the text JSON into image content", async () => {
  const tools = createBrowserTools(fakeClient({ browser_state: () => state() }));
  const result = await tool(tools, "browser_state").handler({ taskId: randomUUID(), tabId: 5 });
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(parsed.screenshot, { width: 500, height: 400, scale: 1 });
  assert.ok(parsed.observationId);
  assert.deepEqual(result.content[1], { type: "image", data: PNG, mimeType: "image/png" });
});

test("errors surface as isError text with code, never silent success", async () => {
  const client = fakeClient({
    browser_click: () => {
      throw new BrowserError("stale_observation", "observe again");
    },
    browser_start_task: () => {
      throw new BrowserError("browser_unavailable", "press Connect");
    },
  });
  const tools = createBrowserTools(client);
  const click = await tool(tools, "browser_click").handler({});
  assert.equal(click.isError, true);
  assert.equal(click.content[0].text, "stale_observation: observe again");
  const start = await tool(tools, "browser_start_task").handler({});
  assert.equal(start.isError, true);
  assert.equal(start.content[0].text, "browser_unavailable: press Connect");
});

test("schemas validate ids, keys, urls and tab ids", () => {
  const tools = createBrowserTools(fakeClient());
  const click = z.object(tool(tools, "browser_click").inputSchema);
  const base = { taskId: randomUUID(), tabId: 5, observationId: randomUUID(), x: 0, y: 0 };
  assert.equal(click.safeParse(base).success, true);
  assert.equal(click.safeParse({ ...base, taskId: "nope" }).success, false);
  assert.equal(click.safeParse({ ...base, tabId: -3 }).success, false);
  const key = z.object(tool(tools, "browser_press_key").inputSchema);
  assert.equal(key.safeParse({ ...base, key: "Enter" }).success, true);
  assert.equal(key.safeParse({ ...base, key: "F5" }).success, false);
  const start = z.object(tool(tools, "browser_start_task").inputSchema);
  assert.equal(start.safeParse({ title: "x".repeat(81), url: "https://a.b" }).success, false);
  assert.equal(start.safeParse({ title: " ", url: "https://a.b" }).success, false);
  assert.equal(start.safeParse({ title: "ok", url: "file:///etc/passwd" }).success, false);
  assert.equal(start.safeParse({ title: "ok", url: "https://u:p@a.b" }).success, false);
  assert.equal(start.safeParse({ title: "ok", url: "https://a.b" }).success, true);
});

test("descriptions mention approval and Chrome extension scope", () => {
  for (const t of createBrowserTools(fakeClient())) {
    assert.match(t.description, /Devin Browser Tasks|extension/i);
  }
});
