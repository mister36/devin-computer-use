import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

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
