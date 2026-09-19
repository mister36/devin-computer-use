#!/usr/bin/env node

import { platform } from "node:os";
import process from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { HelperClient, defaultSocketPath } from "./helper-client.mjs";
import { createTools } from "./tools.mjs";

const socketPath = process.env.DEVIN_COMPUTER_USE_SOCKET || defaultSocketPath();

if (platform() !== "darwin" && !process.env.DEVIN_COMPUTER_USE_SOCKET) {
  console.error(
    "devin-computer-use-server only runs on macOS. "
      + "Set DEVIN_COMPUTER_USE_SOCKET to a helper socket to override.",
  );
  process.exit(1);
}

const client = new HelperClient({ socketPath });
const server = new McpServer({
  name: "computer-use",
  version: "0.1.0",
});

for (const tool of createTools(client)) {
  server.registerTool(tool.name, {
    description: tool.description,
    inputSchema: tool.inputSchema,
  }, (params) => tool.handler(params ?? {}));
}

await server.connect(new StdioServerTransport());
