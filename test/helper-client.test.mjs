import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { HelperClient, HelperError } from "../src/helper-client.mjs";

async function fakeServer(socketPath, onRequest) {
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) {
          break;
        }
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        const request = JSON.parse(line);
        const response = onRequest(request);
        if (response) {
          socket.write(JSON.stringify({ id: request.id, ...response }) + "\n");
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return server;
}

async function withFixture(t, handler, fn) {
  const dir = await mkdtemp(join(tmpdir(), "dcu-client-"));
  const socketPath = join(dir, "helper.sock");
  const server = await fakeServer(socketPath, handler);
  const client = new HelperClient({ socketPath, launch: false });
  try {
    await fn(client, socketPath);
  } finally {
    client.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("sends a JSONL request and resolves the result", async (t) => {
  await withFixture(t, (request) => {
    assert.equal(request.method, "ping");
    assert.deepEqual(request.params, {});
    return { result: { version: "0.1.0", accessibility: true, screenRecording: false } };
  }, async (client) => {
    const result = await client.request("ping");
    assert.equal(result.version, "0.1.0");
    assert.equal(result.accessibility, true);
  });
});

test("surfaces helper errors as typed HelperError", async (t) => {
  await withFixture(t, () => ({ error: { code: "app_not_allowed", message: "denied" } }), async (client) => {
    await assert.rejects(client.request("click", { app: "Notes" }), (error) => {
      assert.ok(error instanceof HelperError);
      assert.equal(error.code, "app_not_allowed");
      assert.equal(error.message, "denied");
      return true;
    });
  });
});

test("times out a request that never gets a response", async (t) => {
  await withFixture(t, () => null, async (client) => {
    await assert.rejects(client.request("click", {}, { timeout: 100 }), (error) => {
      assert.equal(error.code, "timeout");
      return true;
    });
  });
});

test("multiple sequential requests share the connection", async (t) => {
  await withFixture(t, (request) => ({ result: { echo: request.id } }), async (client) => {
    const a = await client.request("ping");
    const b = await client.request("ping");
    assert.equal(a.echo, 1);
    assert.equal(b.echo, 2);
  });
});

test("reports helper_unavailable when the socket is missing and launch is off", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-client-"));
  try {
    const client = new HelperClient({ socketPath: join(dir, "nope.sock"), launch: false });
    await assert.rejects(client.request("ping"), (error) => {
      assert.equal(error.code, "helper_unavailable");
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
