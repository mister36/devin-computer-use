import { execFile } from "node:child_process";
import net from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";

const LAUNCH_RETRY_MS = 8000;
const LAUNCH_RETRY_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 20_000;

export class HelperError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "HelperError";
    this.code = code;
  }
}

export function defaultSocketPath({ home = homedir() } = {}) {
  return join(
    home,
    "Library",
    "Application Support",
    "DevinComputerUse",
    "helper.sock",
  );
}

function openApp() {
  const appPath = join(homedir(), "Applications", "Devin Computer Use.app");
  const targets = [["-a", "Devin Computer Use"], ["-a", appPath]];
  for (const args of targets) {
    try {
      execFile("open", args, { stdio: "ignore" });
      return true;
    } catch {
      // try the next target
    }
  }
  return false;
}

export class HelperClient {
  #socketPath;
  #launch;
  #socket = null;
  #connecting = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();

  constructor({ socketPath, launch = true } = {}) {
    this.#socketPath = socketPath
      || process.env.DEVIN_COMPUTER_USE_SOCKET
      || defaultSocketPath();
    this.#launch = launch;
  }

  get socketPath() {
    return this.#socketPath;
  }

  #connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.#socketPath);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(socket);
      });
      socket.once("error", (error) => {
        socket.destroy();
        reject(error);
      });
    });
  }

  async #connect() {
    const deadline = Date.now() + LAUNCH_RETRY_MS;
    let launched = false;
    for (;;) {
      try {
        return await this.#connectOnce();
      } catch (error) {
        const retryable = error.code === "ECONNREFUSED" || error.code === "ENOENT";
        const canLaunch = retryable
          && this.#launch
          && platform() === "darwin"
          && Date.now() < deadline;
        if (!canLaunch) {
          throw new HelperError(
            "helper_unavailable",
            `Could not connect to the Devin Computer Use helper at ${this.#socketPath} (${error.code}). `
              + "Open the Devin Computer Use app or run `devin-computer-use build-app && devin-computer-use open-app`.",
          );
        }
        if (!launched) {
          launched = true;
          openApp();
        }
        await new Promise((resolve) => setTimeout(resolve, LAUNCH_RETRY_INTERVAL_MS));
      }
    }
  }

  #attach(socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    const drop = (error) => {
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(error instanceof HelperError ? error : new HelperError("helper_unavailable", error.message));
      }
      this.#pending.clear();
      this.#socket = null;
    };
    socket.on("error", drop);
    socket.on("close", () => {
      if (this.#socket === socket) {
        drop(new HelperError("helper_unavailable", "Helper connection closed."));
      }
    });
  }

  #onData(chunk) {
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new HelperError(message.error.code || "helper_error", message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  async request(method, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.#socket) {
      this.#connecting ||= this.#connect().then((socket) => {
        this.#connecting = null;
        this.#attach(socket);
        return socket;
      }, (error) => {
        this.#connecting = null;
        throw error;
      });
      await this.#connecting;
    }

    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new HelperError("timeout", `Helper request ${method} timed out after ${timeout} ms.`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.write(payload, (error) => {
        if (error) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new HelperError("helper_unavailable", error.message));
        }
      });
    });
  }

  close() {
    this.#socket?.destroy();
    this.#socket = null;
  }
}
