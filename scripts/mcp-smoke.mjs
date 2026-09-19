#!/usr/bin/env node
// Manual end-to-end smoke test: drives src/server.mjs over stdio as an MCP
// client against the running helper. Usage: node scripts/mcp-smoke.mjs [app]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2] ?? "TextEdit";
const socket =
  process.env.DEVIN_COMPUTER_USE_SOCKET ??
  join(homedir(), "Library", "Application Support", "DevinComputerUse", "helper.sock");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "src", "server.mjs")],
  env: { ...process.env, DEVIN_COMPUTER_USE_SOCKET: socket },
});
const client = new Client({ name: "mcp-smoke", version: "0.0.0" });
await client.connect(transport);

function show(name, result) {
  console.log(`\n===== ${name} =====`);
  for (const block of result.content) {
    if (block.type === "text") {
      const lines = block.text.split("\n");
      console.log(lines.slice(0, 25).join("\n"));
      if (lines.length > 25) console.log(`... (${lines.length - 25} more lines)`);
    } else if (block.type === "image") {
      const buf = Buffer.from(block.data, "base64");
      const isPng = buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
      console.log(`[image ${block.mimeType} ${buf.length} bytes png=${isPng}]`);
      writeFileSync(`/tmp/mcp-${name}.png`, buf);
    } else {
      console.log(`[${block.type}]`);
    }
  }
  if (result.isError) console.log("(isError=true)");
}

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

show("list_apps", await client.callTool({ name: "list_apps", arguments: {} }));
const state = await client.callTool({ name: "get_app_state", arguments: { app } });
show("get_app_state", state);
const text = state.content.find((b) => b.type === "text")?.text ?? "";
const m = text.match(/^\s*\[(\d+)\] textarea/m);
const textareaId = m ? Number(m[1]) : undefined;
console.log("textarea id:", textareaId);

show("click", await client.callTool({ name: "click", arguments: { app, elementId: textareaId } }));
show(
  "type_text",
  await client.callTool({ name: "type_text", arguments: { app, text: "\ntyped via MCP" } }),
);
show("press_key", await client.callTool({ name: "press_key", arguments: { app, key: "return" } }));
show("get_app_state_full", await client.callTool({ name: "get_app_state", arguments: { app, fullTree: true, screenshot: false } }));

await client.close();
