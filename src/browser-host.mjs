#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  encodeLine,
  encodeNativeFrame,
  LineDecoder,
  MAX_IPC_REQUEST,
  MAX_IPC_RESPONSE,
  NativeFrameDecoder,
} from "./browser-protocol.mjs";

export const HOST_NAME = "ai.devin.browser";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_INFLIGHT_PER_CLIENT = 32;

export function defaultBrowserDir({ home = homedir() } = {}) {
  return join(home, ".config", "devin", "browser");
}

export function defaultSocketPath(options) {
  return join(defaultBrowserDir(options), "bridge.sock");
}

async function listenOnce(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve("live");
    });
    probe.once("error", (error) => resolve(error.code || "error"));
  });
}

async function listen(server, socketPath) {
  const dir = dirname(socketPath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dir);
  const dirOwned = typeof process.getuid !== "function" || dirStat.uid === process.getuid();
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !dirOwned) {
    throw new Error(`Refusing to use non-directory, symlinked or foreign path ${dir}.`);
  }
  await chmod(dir, 0o700);
  try {
    await listenOnce(server, socketPath);
  } catch (error) {
    if (error.code !== "EADDRINUSE") {
      throw error;
    }
    const stat = await lstat(socketPath);
    const owned = typeof process.getuid !== "function" || stat.uid === process.getuid();
    if (!stat.isSocket() || stat.isSymbolicLink() || !owned) {
      throw new Error(`Refusing to replace non-socket at ${socketPath}. Remove it manually.`);
    }
    if (await probeSocket(socketPath) !== "ECONNREFUSED") {
      throw new Error(`Another Devin browser bridge is already listening on ${socketPath}.`);
    }
    const recheck = await lstat(socketPath);
    if (recheck.ino !== stat.ino || recheck.dev !== stat.dev) {
      throw new Error(`Socket at ${socketPath} changed while checking it; refusing to reclaim.`);
    }
    await rm(socketPath);
    await listenOnce(server, socketPath);
  }
  await chmod(socketPath, 0o600);
}

export async function startBridge({
  socketPath = defaultSocketPath(),
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onClose = () => {},
} = {}) {
  const clients = new Map();
  const requests = new Map();
  const native = new NativeFrameDecoder();
  let closed = false;

  const sendToExtension = (message) => {
    output.write(encodeNativeFrame(message));
  };

  function dropClient(sessionId, socket) {
    if (!clients.delete(sessionId)) {
      return;
    }
    for (const [id, request] of requests) {
      if (request.sessionId === sessionId) {
        clearTimeout(request.timer);
        requests.delete(id);
      }
    }
    try {
      sendToExtension({ method: "session_end", sessionId });
    } catch {
    }
    socket.destroy();
  }

  function handleClientMessage(sessionId, client, message) {
    const socket = client.socket;
    if (!message || typeof message !== "object" || Array.isArray(message)
        || (typeof message.id !== "string" && typeof message.id !== "number")
        || typeof message.method !== "string"
        || (message.params !== undefined
          && (typeof message.params !== "object" || message.params === null || Array.isArray(message.params)))) {
      try {
        socket.write(encodeLine({
          id: message && typeof message === "object" ? message.id ?? null : null,
          error: { code: "invalid_request", message: "Requests must be {id, method, params}." },
        }, { max: MAX_IPC_RESPONSE }));
      } catch {
      }
      return;
    }
    if (client.inflight >= MAX_INFLIGHT_PER_CLIENT) {
      dropClient(sessionId, socket);
      return;
    }
    const id = randomUUID();
    let frame;
    try {
      frame = encodeNativeFrame({
        id, sessionId, method: message.method, params: message.params ?? {},
      });
    } catch {
      dropClient(sessionId, socket);
      return;
    }
    const timer = setTimeout(() => {
      requests.delete(id);
      client.inflight -= 1;
      dropClient(sessionId, socket);
    }, timeoutMs);
    requests.set(id, { sessionId, clientId: message.id, timer, client });
    client.inflight += 1;
    output.write(frame);
  }

  function handleExtensionMessage(message) {
    if (!message || typeof message !== "object" || typeof message.id !== "string") {
      return;
    }
    const request = requests.get(message.id);
    if (!request) {
      return;
    }
    requests.delete(message.id);
    clearTimeout(request.timer);
    request.client.inflight -= 1;
    const client = clients.get(request.sessionId);
    if (!client) {
      return;
    }
    const response = { id: request.clientId };
    if (message.error && typeof message.error === "object") {
      response.error = {
        code: String(message.error.code || "error"),
        message: String(message.error.message || "Unknown extension error."),
      };
    } else {
      response.result = message.result ?? null;
    }
    try {
      client.socket.write(encodeLine(response, { max: MAX_IPC_RESPONSE }));
    } catch {
      dropClient(request.sessionId, client.socket);
    }
  }

  async function teardown() {
    if (closed) {
      return;
    }
    closed = true;
    for (const request of requests.values()) {
      clearTimeout(request.timer);
    }
    requests.clear();
    for (const { socket } of clients.values()) {
      socket.destroy();
    }
    clients.clear();
    await new Promise((resolve) => server.close(resolve));
    onClose();
  }

  const server = net.createServer((socket) => {
    const sessionId = randomUUID();
    const client = { socket, lines: new LineDecoder({ max: MAX_IPC_REQUEST }), inflight: 0 };
    clients.set(sessionId, client);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = client.lines.push(chunk);
      } catch {
        dropClient(sessionId, socket);
        return;
      }
      for (const message of messages) {
        if (closed || !clients.has(sessionId)) {
          break;
        }
        try {
          handleClientMessage(sessionId, client, message);
        } catch {
          dropClient(sessionId, socket);
          return;
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => dropClient(sessionId, socket));
  });

  await listen(server, socketPath);

  input.on("data", (chunk) => {
    if (closed) {
      return;
    }
    let messages;
    try {
      messages = native.push(chunk);
    } catch (error) {
      stderr.write(`devin browser host: ${error.message}\n`);
      setImmediate(() => {
        void teardown();
      });
      return;
    }
    try {
      for (const message of messages) {
        handleExtensionMessage(message);
      }
    } catch (error) {
      stderr.write(`devin browser host: ${error.message}\n`);
      setImmediate(() => {
        void teardown();
      });
    }
  });
  input.on("end", () => {
    void teardown();
  });
  input.on("error", () => {
    void teardown();
  });
  output.on("error", () => {
    void teardown();
  });
  output.on("close", () => {
    setImmediate(() => {
      void teardown();
    });
  });

  return {
    socketPath,
    close: teardown,
    get clients() {
      return clients.size;
    },
  };
}

const isEntrypoint = process.argv[1]
  && process.argv[1] !== "-"
  && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  startBridge({
    onClose: () => process.exit(0),
  })
    .then((bridge) => {
      process.on("SIGINT", () => bridge.close());
      process.on("SIGTERM", () => bridge.close());
    })
    .catch((error) => {
      console.error(`devin browser host: ${error.message}`);
      process.exitCode = 1;
    });
}
