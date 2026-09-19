import assert from "node:assert/strict";
import test from "node:test";

import { HelperError } from "../src/helper-client.mjs";
import { createTools } from "../src/tools.mjs";

const PNG = "aGVsbG8="; // base64 for a tiny fake png payload

function stateFor(elements = [{ id: 1, role: "button", label: "OK", depth: 0 }], scale = 2) {
  return {
    app: { pid: 1, name: "Notes", bundleId: "com.apple.Notes" },
    window: { id: 5, title: "Win", bounds: [0, 0, 800, 600] },
    elements,
    screenshot: { png: PNG, width: 1280, height: 960, scale },
  };
}

function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params = {}) => {
      calls.push({ method, params });
      if (handlers[method]) {
        return handlers[method](params, calls.length);
      }
      return { ok: true };
    },
  };
}

const tool = (tools, name) => tools.find((t) => t.name === name);

test("click with elementId returns diff text plus image", async () => {
  const client = fakeClient({ get_app_state: () => stateFor() });
  const tools = createTools(client, { settleMs: 0 });
  const result = await tool(tools, "click").handler({ app: "Notes", elementId: 3 });
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /^window: Notes/);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].data, PNG);
  assert.equal(result.content[1].mimeType, "image/png");
  assert.deepEqual(client.calls[0], { method: "click", params: { app: "Notes", elementId: 3 } });
});

test("coordinates are divided by the last screenshot scale", async () => {
  const client = fakeClient({ get_app_state: () => stateFor() });
  const tools = createTools(client, { settleMs: 0 });
  await tool(tools, "get_app_state").handler({ app: "Notes" });
  await tool(tools, "click").handler({ app: "Notes", x: 200, y: 100 });
  const click = client.calls.find((c) => c.method === "click");
  assert.equal(click.params.x, 100);
  assert.equal(click.params.y, 50);
});

test("coordinates default to scale 1 before any screenshot", async () => {
  const client = fakeClient({ get_app_state: () => stateFor() });
  const tools = createTools(client, { settleMs: 0 });
  await tool(tools, "click").handler({ app: "Notes", x: 200, y: 100 });
  const click = client.calls.find((c) => c.method === "click");
  assert.equal(click.params.x, 200);
});

test("observe:false skips the post-action state", async () => {
  const client = fakeClient({ get_app_state: () => stateFor() });
  const tools = createTools(client, { settleMs: 0 });
  const result = await tool(tools, "click").handler({ app: "Notes", elementId: 1, observe: false });
  assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
  assert.deepEqual(client.calls.map((c) => c.method), ["click"]);
});

test("app_not_allowed maps to a friendly error result", async () => {
  const client = fakeClient({
    click: () => {
      throw new HelperError("app_not_allowed", "denied");
    },
  });
  const tools = createTools(client, { settleMs: 0 });
  const result = await tool(tools, "click").handler({ app: "Notes", elementId: 1 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /user declined to let Devin use "Notes"/);
  assert.match(result.content[0].text, /Devin Computer Use menu-bar app/);
});

test("get_app_state diffs against the previous observation", async () => {
  const first = stateFor([{ id: 1, role: "button", label: "OK", depth: 0 }]);
  const second = stateFor([
    { id: 4, role: "button", label: "OK", depth: 0 },
    { id: 5, role: "text", label: "Hi", depth: 0 },
  ]);
  const states = [first, second];
  const client = fakeClient({ get_app_state: () => states.shift() });
  const tools = createTools(client, { settleMs: 0 });
  const a = await tool(tools, "get_app_state").handler({ app: "Notes" });
  assert.match(a.content[0].text, /full\)/);
  const b = await tool(tools, "get_app_state").handler({ app: "Notes" });
  assert.match(b.content[0].text, /diff vs previous/);
  assert.match(b.content[0].text, /\+ \[5\] text "Hi"/);
});

test("wait caps at 10000 ms", async () => {
  const slept = [];
  const tools = createTools(fakeClient(), { sleep: async (ms) => slept.push(ms) });
  const result = await tool(tools, "wait").handler({ ms: 999_999 });
  assert.equal(result.content[0].text, "waited 10000 ms");
  assert.deepEqual(slept, [10_000]);
});
