import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const ENV = {
  ...process.env,
  DEVIN_COMPUTER_USE_SOCKET: "/tmp/dcu-test-missing.sock",
  DEVIN_BROWSER_SOCKET: "/tmp/dcu-test-missing-browser.sock",
};

function spawnServer(t) {
  const child = spawn(process.execPath, [serverPath], { env: ENV });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    child.kill("SIGKILL");
  });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        lines.push(JSON.parse(line));
      }
    }
  });
  const waitExit = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const rpc = async (message) => {
    const start = lines.length;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    for (let i = 0; i < 100 && !lines.some((l) => l.id === message.id); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return lines.find((l) => l.id === message.id);
  };
  return { child, lines, rpc, waitExit, getStderr: () => stderr };
}

test("server exits non-zero with a clear message on Linux without the socket env var", {
  skip: process.platform === "darwin",
}, () => {
  const result = spawnSync(process.execPath, [serverPath], {
    encoding: "utf8",
    env: { ...process.env, DEVIN_COMPUTER_USE_SOCKET: undefined },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only runs on macOS/);
});

test("server registers native and browser tools and exits on stdin EOF", async (t) => {
  const { child, rpc, waitExit, getStderr } = spawnServer(t);
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  });
  assert.ok(init, `no init response; stderr: ${getStderr()}`);
  assert.equal(init.result.serverInfo.name, "computer-use");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.result.tools.map((t) => t.name);
  for (const native of ["list_apps", "get_app_state", "click"]) {
    assert.ok(names.includes(native), native);
  }
  const browser = names.filter((n) => n.startsWith("browser_"));
  assert.equal(browser.length, 10);
  child.stdin.end();
  const { code } = await waitExit();
  assert.equal(code, 0);
});

test("SIGTERM exits cleanly", async (t) => {
  const { child, waitExit, getStderr } = spawnServer(t);
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  const { code } = await waitExit();
  assert.equal(code, 143);
});
