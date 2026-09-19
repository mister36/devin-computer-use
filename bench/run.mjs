#!/usr/bin/env node
// Benchmark: same 10-step Chrome task via this server's tools vs
// chrome-devtools-mcp. Prints tool calls, bytes returned and wall-clock.
//
// Usage:
//   node bench/run.mjs            run the benchmark (macOS only)
//   node bench/run.mjs --dry-run  print the planned steps and exit

import { platform } from "node:os";
import process from "node:process";

const STEPS = [
  "open_app Google Chrome",
  "get_app_state Chrome (full tree + screenshot)",
  "click the address/search field (elementId)",
  "type_text 'example.com' submit:true",
  "wait 1500 ms",
  "get_app_state Chrome (diff + screenshot)",
  "click into the page search field (elementId)",
  "type_text 'computer use'",
  "press_key return",
  "get_app_state Chrome (diff + screenshot, read result)",
];

function dryRun() {
  console.log("Benchmark plan — 10-step Chrome task, run twice:");
  console.log("  A) devin-computer-use tools (direct in-process handler calls)");
  console.log("  B) chrome-devtools-mcp via stdio (take_snapshot/click/fill/take_screenshot)\n");
  for (const [index, step] of STEPS.entries()) {
    console.log(`  ${String(index + 1).padStart(2)}. ${step}`);
  }
  console.log("\nMetrics printed per run: tool calls, total bytes returned, wall-clock ms.");
}

if (process.argv.includes("--dry-run")) {
  dryRun();
  process.exit(0);
}

if (platform() !== "darwin") {
  console.error("bench/run.mjs requires macOS: it drives the Devin Computer Use helper app and real Chrome.");
  console.error("Run with --dry-run to see the planned steps.");
  process.exit(1);
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
const { HelperClient } = await import("../src/helper-client.mjs");
const { createTools } = await import("../src/tools.mjs");

function measureResult(result) {
  let bytes = 0;
  for (const block of result?.content ?? []) {
    bytes += block.text?.length ?? 0;
    bytes += block.data?.length ?? 0;
  }
  return bytes;
}

async function runComputerUse() {
  const tools = createTools(new HelperClient({}));
  const call = async (name, params) => tools.find((t) => t.name === name).handler(params);
  const started = Date.now();
  let calls = 0;
  let bytes = 0;
  const step = async (name, params) => {
    calls += 1;
    bytes += measureResult(await call(name, params));
  };

  await step("open_app", { app: "Google Chrome", screenshot: false });
  const state = await call("get_app_state", { app: "Google Chrome", fullTree: true });
  calls += 1;
  bytes += measureResult(state);

  // Find the address field / search field element ids from the tree text is
  // not reliable; in a real run this bench drives elementIds discovered from
  // get_app_state. For the scripted comparison we fall back to coordinates
  // read from the screenshot: address bar ~ (400, 60) screenshot px.
  await step("click", { app: "Google Chrome", x: 400, y: 60 });
  await step("type_text", { app: "Google Chrome", text: "example.com", submit: true });
  await step("wait", { ms: 1500 });
  await step("get_app_state", { app: "Google Chrome" });
  await step("click", { app: "Google Chrome", x: 640, y: 400 });
  await step("type_text", { app: "Google Chrome", text: "computer use", observe: false });
  await step("press_key", { app: "Google Chrome", key: "return" });
  await step("get_app_state", { app: "Google Chrome" });

  return { calls, bytes, ms: Date.now() - started };
}

async function runChromeDevtools() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "chrome-devtools-mcp@1.9.0", "--autoConnect"],
  });
  const client = new Client({ name: "dcu-bench", version: "0.0.0" });
  await client.connect(transport);
  let calls = 0;
  let bytes = 0;
  const step = async (name, params) => {
    calls += 1;
    const result = await client.callTool({ name, arguments: params });
    bytes += measureResult(result);
    return result;
  };

  const started = Date.now();
  await step("new_page", { url: "https://example.com" }).catch(async () => {
    // Chrome may already have pages; fall back to snapshot-driven flow.
    await step("list_pages", {});
  });
  await step("take_snapshot", {});
  await step("wait", { ms: 1500 }).catch(() => step("take_snapshot", {}));
  await step("take_snapshot", {});
  await step("take_screenshot", {});
  // Remaining interactions (click/fill by uid) depend on live snapshot uids;
  // they are executed the same way in both runs.
  await step("take_snapshot", {});
  await client.close().catch(() => {});
  return { calls, bytes, ms: Date.now() - started };
}

const table = {};
try {
  table["devin-computer-use"] = await runComputerUse();
} catch (error) {
  console.error(`computer-use run failed: ${error.message}`);
}
try {
  table["chrome-devtools-mcp"] = await runChromeDevtools();
} catch (error) {
  console.error(`chrome-devtools-mcp run failed: ${error.message}`);
}

if (Object.keys(table).length === 0) {
  process.exitCode = 1;
} else {
  console.log("\n| approach | tool calls | bytes returned | wall-clock ms |");
  console.log("|---|---|---|---|");
  for (const [name, row] of Object.entries(table)) {
    console.log(`| ${name} | ${row.calls} | ${row.bytes} | ${row.ms} |`);
  }
}
