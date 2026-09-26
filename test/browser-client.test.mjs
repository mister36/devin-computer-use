import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BrowserClient, BrowserError } from "../src/browser-client.mjs";

async function fakeBridge(socketPath, onRequest) {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) {
          return;
        }
        const line = buffer.subarray(0, newline).toString("utf8");
        buffer = buffer.subarray(newline + 1);
        const response = onRequest(JSON.parse(line), socket);
        if (response) {
          socket.write(`${JSON.stringify({ id: JSON.parse(line).id, ...response })}\n`);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return server;
}

async function withFixture(t, handler, fn, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  const server = await fakeBridge(socketPath, handler);
  const client = new BrowserClient({ socketPath, ...options });
  try {
    await fn(client, socketPath);
  } finally {
    client.close();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("reports browser_unavailable with connect instructions when the socket is missing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  try {
    const client = new BrowserClient({ socketPath: join(dir, "missing.sock") });
    await assert.rejects(client.request("browser_task_status", {}), (error) => {
      assert.equal(error.code, "browser_unavailable");
      assert.match(error.message, /Devin Browser Tasks/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("round-trips results and propagates errors", async (t) => {
  await withFixture(t, (request) => {
    if (request.method === "fail") {
      return { error: { code: "task_stopped", message: "stopped" } };
    }
    return { result: { ok: true } };
  }, async (client) => {
    assert.deepEqual(await client.request("browser_task_status"), { ok: true });
    await assert.rejects(client.request("fail"), (error) => {
      assert.ok(error instanceof BrowserError);
      assert.equal(error.code, "task_stopped");
      return true;
    });
  });
});

test("disconnect rejects pending and the next request is a fresh session", async (t) => {
  let server;
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  const sockets = [];
  server = await fakeBridge(socketPath, (request, socket) => {
    if (request.method === "hang") {
      return null;
    }
    return { result: { n: sockets.length } };
  });
  server.on("connection", (socket) => sockets.push(socket));
  const client = new BrowserClient({ socketPath });
  try {
    const pending = client.request("hang");
    await new Promise((resolve) => setTimeout(resolve, 20));
    sockets[0].destroy();
    await assert.rejects(pending, (error) => error.code === "browser_unavailable");
    const result = await client.request("browser_task_status");
    assert.equal(result.n, 2);
  } finally {
    client.close();
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeout destroys the socket (fail closed)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  const sockets = [];
  const server = await fakeBridge(socketPath, () => null);
  server.on("connection", (socket) => sockets.push(socket));
  const client = new BrowserClient({ socketPath });
  try {
    await assert.rejects(
      client.request("browser_state", {}, { timeout: 60 }),
      (error) => error.code === "timeout",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sockets[0].destroyed, true);
  } finally {
    client.close();
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized inbound data drops the connection and rejects pending", async (t) => {
  await withFixture(t, (request, socket) => {
    socket.write(Buffer.alloc(8 * 1024));
    return null;
  }, async (client) => {
    await assert.rejects(client.request("browser_state"), (error) => {
      assert.equal(error.code, "browser_unavailable");
      return true;
    });
  }, { maxResponse: 1024 });
});

test("a truncated message cannot poison the next connection's decoder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  let attempts = 0;
  const sockets = [];
  const server = await fakeBridge(socketPath, (request, socket) => {
    if (attempts === 1) {
      socket.end(`{"id":${request.id},"result":{"cu`);
      return null;
    }
    return { result: { ok: true } };
  });
  server.on("connection", (socket) => {
    sockets.push(socket);
    attempts += 1;
  });
  const client = new BrowserClient({ socketPath });
  try {
    await assert.rejects(client.request("browser_state"), (e) => e.code === "browser_unavailable");
    const result = await client.request("browser_task_status");
    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
  } finally {
    client.close();
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a timeout drops the session; queued requests never reach a fresh socket", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  const received = [];
  const sockets = [];
  const server = await fakeBridge(socketPath, (request) => {
    received.push(request.method);
    if (request.method === "hang") {
      return null;
    }
    return { result: { ok: true } };
  });
  server.on("connection", (socket) => sockets.push(socket));
  const client = new BrowserClient({ socketPath });
  try {
    const hung = client.request("hang", {}, { timeout: 60 });
    const queued = client.request("browser_state");
    await assert.rejects(hung, (e) => e.code === "timeout");
    await assert.rejects(queued, (e) => e.code === "browser_unavailable");
    assert.deepEqual(received, ["hang"]);
    const fresh = await client.request("browser_task_status");
    assert.deepEqual(fresh, { ok: true });
    assert.deepEqual(received, ["hang", "browser_task_status"]);
  } finally {
    client.close();
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("close rejects pending and queued work and prevents reconnect", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-browser-"));
  const socketPath = join(dir, "bridge.sock");
  const received = [];
  const sockets = [];
  const server = await fakeBridge(socketPath, (request) => {
    received.push(request.method);
    if (request.method === "hang") {
      return null;
    }
    return { result: { ok: true } };
  });
  server.on("connection", (socket) => sockets.push(socket));
  const client = new BrowserClient({ socketPath });
  try {
    const pending = client.request("hang");
    const queued = client.request("browser_state");
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.close();
    await assert.rejects(pending, (e) => e.code === "browser_unavailable");
    await assert.rejects(queued, (e) => e.code === "browser_unavailable");
    await assert.rejects(client.request("browser_task_status"), (e) => e.code === "browser_unavailable");
    assert.deepEqual(received, ["hang"]);
    assert.equal(sockets.length, 1);
  } finally {
    client.close();
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("close during connection establishment rejects pending and queued requests", async (t) => {
  const sockets = [];
  const connect = () => {
    const socket = new EventEmitter();
    socket.setNoDelay = () => {};
    socket.write = () => {};
    socket.destroy = () => {
      queueMicrotask(() => socket.emit("close"));
    };
    sockets.push(socket);
    return socket;
  };
  const client = new BrowserClient({ socketPath: "/unused", connect });
  const pending = client.request("browser_state");
  const queued = client.request("browser_task_status");
  await new Promise((resolve) => setTimeout(resolve, 10));
  client.close();
  await assert.rejects(pending, (e) => e.code === "browser_unavailable");
  await assert.rejects(queued, (e) => e.code === "browser_unavailable");
  assert.equal(sockets.length, 1);
  await assert.rejects(client.request("ping"), (e) => e.code === "browser_unavailable");
});

test("a failed connect invalidates queued work but not future requests", async () => {
  let calls = 0;
  const connect = () => {
    calls += 1;
    const socket = new EventEmitter();
    socket.setNoDelay = () => {};
    socket.write = () => {};
    socket.destroy = () => {};
    if (calls === 1) {
      queueMicrotask(() => socket.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
    } else {
      queueMicrotask(() => socket.emit("connect"));
    }
    return socket;
  };
  const client = new BrowserClient({ socketPath: "/unused", connect });
  const first = client.request("browser_state");
  const queued = client.request("browser_task_status");
  await assert.rejects(first, (e) => e.code === "browser_unavailable");
  await assert.rejects(queued, (e) => e.code === "browser_unavailable");
  assert.equal(calls, 1);
  await assert.rejects(
    client.request("browser_task_status", {}, { timeout: 50 }),
    (e) => e.code === "timeout",
  );
  assert.equal(calls, 2);
  client.close();
});
