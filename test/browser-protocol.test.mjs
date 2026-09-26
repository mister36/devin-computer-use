import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { startBridge } from "../src/browser-host.mjs";
import {
  encodeLine,
  encodeNativeFrame,
  LineDecoder,
  MAX_IPC_REQUEST,
  MAX_NATIVE_FROM_EXTENSION,
  NativeFrameDecoder,
} from "../src/browser-protocol.mjs";

test("native frames round-trip, split and coalesced", () => {
  const decoder = new NativeFrameDecoder();
  const a = encodeNativeFrame({ id: "1", result: { ok: true } });
  const b = encodeNativeFrame({ id: "2", result: "héllo ✓" });
  const whole = Buffer.concat([a, b]);
  const messages = [];
  messages.push(...decoder.push(whole.subarray(0, 3)));
  messages.push(...decoder.push(whole.subarray(3, 9)));
  messages.push(...decoder.push(whole.subarray(9)));
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { id: "1", result: { ok: true } });
  assert.equal(messages[1].result, "héllo ✓");
});

test("native decoder rejects zero-length, oversized and invalid frames", () => {
  const zero = Buffer.alloc(4);
  assert.throws(() => new NativeFrameDecoder().push(zero), /zero-length/);
  const big = Buffer.alloc(4);
  big.writeUInt32LE(MAX_NATIVE_FROM_EXTENSION + 1, 0);
  assert.throws(() => new NativeFrameDecoder().push(big), /exceeds/);
  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(3, 0);
  assert.throws(() => new NativeFrameDecoder().push(Buffer.concat([bad, Buffer.from("nope")])), /not valid JSON/);
});

test("line decoder bounds long lines and tolerates fragmented utf8", () => {
  const decoder = new LineDecoder({ max: 64 });
  const text = "ünïcode";
  const payload = Buffer.from(`${JSON.stringify({ id: 1, text })}\n`, "utf8");
  const messages = [];
  for (const byte of payload) {
    messages.push(...decoder.push(Buffer.from([byte])));
  }
  assert.equal(messages[0].text, text);
  const tooLong = new LineDecoder({ max: 8 });
  assert.throws(() => tooLong.push(Buffer.from("123456789")), /exceeds/);
  assert.throws(() => new LineDecoder().push(Buffer.from("{bad json}\n")), /not valid JSON/);
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

async function fixture(t, { timeoutMs } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dcu-bridge-"));
  const socketPath = join(dir, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = new NativeFrameDecoder();
  const bridge = await startBridge({ socketPath, input, output, timeoutMs });
  const toExtension = [];
  output.on("data", (chunk) => {
    toExtension.push(...frames.push(chunk));
  });
  t.after(async () => {
    await bridge.close();
    input.destroy();
    output.destroy();
    await rm(dir, { recursive: true, force: true });
  });
  return { bridge, socketPath, input, toExtension };
}

async function ipcClient(t, socketPath) {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const lines = new LineDecoder();
  const incoming = [];
  socket.on("data", (chunk) => {
    incoming.push(...lines.push(chunk));
  });
  t.after(() => socket.destroy());
  const next = () => new Promise((resolve) => {
    const poll = () => (incoming.length ? resolve(incoming.shift()) : setImmediate(poll));
    poll();
  });
  return { socket, incoming, next, send: (msg) => socket.write(encodeLine(msg, { max: MAX_IPC_REQUEST })) };
}

test("host isolates identical request ids across clients and ignores forged sessions", async (t) => {
  const { socketPath, input, toExtension } = await fixture(t);
  const a = await ipcClient(t, socketPath);
  const b = await ipcClient(t, socketPath);
  await flush();

  a.send({ id: 7, method: "browser_task_status", params: {}, sessionId: "forged" });
  b.send({ id: 7, method: "browser_start_task", params: { title: "x" } });
  await flush();
  assert.equal(toExtension.length, 2);
  const [fa, fb] = toExtension;
  assert.notEqual(fa.sessionId, fb.sessionId);
  assert.notEqual(fa.sessionId, "forged");
  assert.equal(fa.method, "browser_task_status");

  input.write(encodeNativeFrame({ id: fb.id, result: { taskId: "t1" } }));
  const rb = await b.next();
  assert.deepEqual(rb, { id: 7, result: { taskId: "t1" } });
  input.write(encodeNativeFrame({ id: fa.id, error: { code: "boom", message: "failed" } }));
  const ra = await a.next();
  assert.deepEqual(rb.id, ra.id);
  assert.equal(ra.error.code, "boom");

  input.write(encodeNativeFrame({ id: fb.id, result: { late: true } }));
  await flush();
  assert.equal(a.incoming.length + b.incoming.length, 0);
});

test("client disconnect emits session_end and drops its requests", async (t) => {
  const { socketPath, input, toExtension } = await fixture(t);
  const client = await ipcClient(t, socketPath);
  client.send({ id: 1, method: "browser_state", params: {} });
  await flush();
  const forwarded = toExtension[0];
  client.socket.destroy();
  await flush();
  const end = toExtension.find((m) => m.method === "session_end");
  assert.equal(end.sessionId, forwarded.sessionId);
  input.write(encodeNativeFrame({ id: forwarded.id, result: {} }));
  await flush();
});

test("request timeout drops the client session", async (t) => {
  const { socketPath, toExtension } = await fixture(t, { timeoutMs: 50 });
  const client = await ipcClient(t, socketPath);
  client.send({ id: 1, method: "browser_state", params: {} });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(toExtension.some((m) => m.method === "session_end"));
});

test("stdin EOF tears down clients and the socket", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-bridge-"));
  const socketPath = join(dir, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  const bridge = await startBridge({
    socketPath, input, output, onClose: () => {
      closed = true;
    },
  });
  const client = await ipcClient(t, socketPath);
  await flush();
  input.end();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, true);
  assert.equal(bridge.clients, 0);
  await rm(dir, { recursive: true, force: true });
});

test("a second bridge refuses a live socket; non-socket files are never reclaimed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-bridge-"));
  const socketPath = join(dir, "bridge.sock");
  const first = await startBridge({
    socketPath, input: new PassThrough(), output: new PassThrough(),
  });
  try {
    await assert.rejects(
      startBridge({ socketPath, input: new PassThrough(), output: new PassThrough() }),
      /already listening/,
    );
  } finally {
    await first.close();
  }
  const file = join(dir, "file.sock");
  await writeFile(file, "not a socket");
  await assert.rejects(
    startBridge({ socketPath: file, input: new PassThrough(), output: new PassThrough() }),
    /Refusing/,
  );
  const link = join(dir, "link.sock");
  await symlink("/tmp/nope", link);
  await assert.rejects(
    startBridge({ socketPath: link, input: new PassThrough(), output: new PassThrough() }),
    /Refusing/,
  );
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  await rm(dir, { recursive: true, force: true });
});

test("an oversized forwarded envelope drops only that client", async (t) => {
  const { socketPath, toExtension } = await fixture(t);
  const big = await ipcClient(t, socketPath);
  const normal = await ipcClient(t, socketPath);
  await flush();
  const overhead = JSON.stringify({ id: 1, method: "browser_type_text", params: { text: "" } }).length;
  big.send({
    id: 1,
    method: "browser_type_text",
    params: { text: "x".repeat(MAX_IPC_REQUEST - overhead - 10) },
  });
  await flush();
  assert.ok(toExtension.some((m) => m.method === "session_end"));
  assert.equal(big.socket.destroyed, true);
  normal.send({ id: 2, method: "browser_task_status", params: {} });
  await flush();
  assert.ok(toExtension.some((m) => m.method === "browser_task_status"));
});

test("malformed native input and output failure tear down the bridge", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dcu-bridge-"));
  const socketPath = join(dir, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  let closed = false;
  const bridge = await startBridge({
    socketPath, input, output, onClose: () => {
      closed = true;
    },
  });
  const bad = Buffer.alloc(4);
  bad.writeUInt32LE(3, 0);
  input.write(Buffer.concat([bad, Buffer.from("###")]));
  await flush();
  assert.equal(closed, true);
  await rm(dir, { recursive: true, force: true });

  const dir2 = await mkdtemp(join(tmpdir(), "dcu-bridge-"));
  const input2 = new PassThrough();
  const output2 = new PassThrough();
  let closed2 = false;
  await startBridge({
    socketPath: join(dir2, "bridge.sock"), input: input2, output: output2,
    onClose: () => {
      closed2 = true;
    },
  });
  output2.destroy(new Error("gone"));
  await flush();
  assert.equal(closed2, true);
  await rm(dir2, { recursive: true, force: true });
});

test("coalesced messages from a dropped client are not forwarded", async (t) => {
  const { socketPath, toExtension } = await fixture(t);
  const client = await ipcClient(t, socketPath);
  const overhead = JSON.stringify({ id: 1, method: "browser_type_text", params: { text: "" } }).length;
  const bad = encodeLine({
    id: 1,
    method: "browser_type_text",
    params: { text: "x".repeat(MAX_IPC_REQUEST - overhead - 10) },
  }, { max: MAX_IPC_REQUEST });
  const good = encodeLine({ id: 2, method: "browser_task_status", params: {} }, { max: MAX_IPC_REQUEST });
  client.socket.write(Buffer.concat([bad, good]));
  await flush();
  assert.ok(toExtension.some((m) => m.method === "session_end"));
  assert.ok(!toExtension.some((m) => m.method === "browser_task_status"));
});
