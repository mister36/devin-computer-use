import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  encodeLine,
  LineDecoder,
  MAX_IPC_REQUEST,
  MAX_IPC_RESPONSE,
} from "./browser-protocol.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;

export class BrowserError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "BrowserError";
    this.code = code;
  }
}

export function defaultBrowserSocketPath({ home = homedir() } = {}) {
  return join(home, ".config", "devin", "browser", "bridge.sock");
}

function unavailable(socketPath, detail) {
  return new BrowserError(
    "browser_unavailable",
    `Could not reach the Devin Browser Tasks extension (${detail}). `
      + "Load this repo's extension directory in Chrome, run "
      + "`devin-computer-use install-browser --extension-id <id>`, then press "
      + "Connect in the extension popup and retry.",
  );
}

export class BrowserClient {
  #socketPath;
  #maxResponse;
  #socket = null;
  #connecting = null;
  #connectingSocket = null;
  #decoder = null;
  #createConnection;
  #nextId = 1;
  #pending = new Map();
  #queue = Promise.resolve();
  #closed = false;
  #generation = 0;

  constructor({ socketPath, maxResponse = MAX_IPC_RESPONSE, connect = (path) => net.createConnection(path) } = {}) {
    this.#socketPath = socketPath
      || process.env.DEVIN_BROWSER_SOCKET
      || defaultBrowserSocketPath();
    this.#maxResponse = maxResponse;
    this.#createConnection = connect;
  }

  get socketPath() {
    return this.#socketPath;
  }

  #connect(generation) {
    if (this.#closed) {
      return Promise.reject(new BrowserError("browser_unavailable", "BrowserClient is closed."));
    }
    if (generation !== this.#generation) {
      return Promise.reject(new BrowserError(
        "browser_unavailable",
        "The previous browser session ended; this request was not sent.",
      ));
    }
    if (this.#socket) {
      return Promise.resolve(this.#socket);
    }
    this.#connecting ||= new Promise((resolve, reject) => {
      const socket = this.#createConnection(this.#socketPath);
      this.#connectingSocket = socket;
      let settled = false;
      const fail = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        this.#connectingSocket = null;
        this.#generation += 1;
        socket.destroy();
        reject(error);
      };
      socket.on("error", (error) => {
        if (!settled) {
          fail(unavailable(this.#socketPath, error.code || error.message));
        }
      });
      socket.on("close", () => {
        if (!settled) {
          fail(unavailable(this.#socketPath, "connection closed before it opened"));
        }
      });
      socket.once("connect", () => {
        if (settled) {
          return;
        }
        settled = true;
        this.#connectingSocket = null;
        if (this.#closed || generation !== this.#generation) {
          socket.destroy();
          reject(new BrowserError(
            "browser_unavailable",
            "The browser connection closed before it was established.",
          ));
          return;
        }
        this.#attach(socket);
        resolve(socket);
      });
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #attach(socket) {
    this.#socket = socket;
    this.#decoder = new LineDecoder({ max: this.#maxResponse });
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      let messages;
      try {
        messages = this.#decoder.push(chunk);
      } catch (error) {
        this.#drop(unavailable(this.#socketPath, error.message));
        return;
      }
      for (const message of messages) {
        this.#onMessage(message);
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#drop(unavailable(this.#socketPath, "connection closed"));
      }
    });
  }

  #drop(error) {
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = null;
    this.#decoder = null;
    socket?.destroy();
    this.#connectingSocket?.destroy();
    this.#connectingSocket = null;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }

  #onMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new BrowserError(
        message.error.code || "browser_error",
        message.error.message,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  request(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    const generation = this.#generation;
    const run = this.#queue.then(() => this.#request(method, params, { timeout, generation }));
    this.#queue = run.then(() => {}, () => {});
    return run;
  }

  async #request(method, params, { timeout, generation }) {
    if (this.#closed) {
      throw new BrowserError("browser_unavailable", "BrowserClient is closed.");
    }
    if (generation !== this.#generation) {
      throw new BrowserError(
        "browser_unavailable",
        "The previous browser session ended; this request was not sent.",
      );
    }
    await this.#connect(generation);
    if (this.#closed || generation !== this.#generation || !this.#socket) {
      throw new BrowserError("browser_unavailable", "The browser session ended before this request was sent.");
    }
    const id = this.#nextId++;
    const payload = encodeLine({ id, method, params }, { max: MAX_IPC_REQUEST });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.#drop(new BrowserError(
          "timeout",
          `Browser request ${method} timed out after ${timeout} ms.`,
        ));
        reject(new BrowserError(
          "timeout",
          `Browser request ${method} timed out after ${timeout} ms.`,
        ));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(payload, (error) => {
        if (error) {
          this.#pending.delete(id);
          clearTimeout(timer);
          const wrapped = unavailable(this.#socketPath, error.message);
          this.#drop(wrapped);
          reject(wrapped);
        }
      });
    });
  }

  close() {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#drop(new BrowserError("browser_unavailable", "BrowserClient is closed."));
  }
}
