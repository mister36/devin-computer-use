#!/usr/bin/env node

import { platform } from "node:os";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BrowserClient, defaultBrowserSocketPath } from "./browser-client.mjs";
import { createBrowserTools } from "./browser-tools.mjs";
import { HelperClient, defaultSocketPath } from "./helper-client.mjs";
import { createTools } from "./tools.mjs";

const socketPath = process.env.DEVIN_COMPUTER_USE_SOCKET || defaultSocketPath();
const browserSocketPath = process.env.DEVIN_BROWSER_SOCKET || defaultBrowserSocketPath();

if (platform() !== "darwin" && !process.env.DEVIN_COMPUTER_USE_SOCKET) {
  console.error(
    "devin-computer-use-server only runs on macOS. "
      + "Set DEVIN_COMPUTER_USE_SOCKET to a helper socket to override.",
  );
  process.exit(1);
}

const client = new HelperClient({ socketPath });
const browserClient = new BrowserClient({ socketPath: browserSocketPath });
const server = new McpServer({
  name: "computer-use",
  version: "0.1.0",
});

for (const tool of [...createTools(client), ...createBrowserTools(browserClient)]) {
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.inputSchema,
  }, (params) => tool.handler(params ?? {}));
}

const transport = new StdioServerTransport();
const closeClients = () => {
  client.close();
  browserClient.close();
};
server.server.onclose = closeClients;
const shutdown = async () => {
  try {
    closeClients();
    await server.close();
  } catch (error) {
    console.error(`shutdown: ${error.message}`);
  }
};
process.stdin.once("end", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(130));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(143));
});
await server.connect(transport);
