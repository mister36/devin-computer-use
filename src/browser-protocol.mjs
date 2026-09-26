export const MAX_NATIVE_TO_EXTENSION = 1024 * 1024;
export const MAX_NATIVE_FROM_EXTENSION = 64 * 1024 * 1024;
export const MAX_IPC_REQUEST = 1024 * 1024;
export const MAX_IPC_RESPONSE = 64 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export function encodeNativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_NATIVE_TO_EXTENSION) {
    throw new ProtocolError("frame_too_large", `Native message exceeds ${MAX_NATIVE_TO_EXTENSION} bytes.`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  #buffer = Buffer.alloc(0);
  #max;

  constructor({ max = MAX_NATIVE_FROM_EXTENSION } = {}) {
    this.#max = max;
  }

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages = [];
    for (;;) {
      if (this.#buffer.length < 4) {
        return messages;
      }
      const length = this.#buffer.readUInt32LE(0);
      if (length === 0) {
        throw new ProtocolError("bad_frame", "Received a zero-length native frame.");
      }
      if (length > this.#max) {
        throw new ProtocolError("frame_too_large", `Native frame of ${length} bytes exceeds the limit.`);
      }
      if (this.#buffer.length < 4 + length) {
        return messages;
      }
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new ProtocolError("bad_frame", "Native frame was not valid JSON.");
      }
    }
  }
}

export function encodeLine(message, { max = MAX_IPC_RESPONSE } = {}) {
  const body = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
  if (body.length > max) {
    throw new ProtocolError("frame_too_large", `IPC message exceeds ${max} bytes.`);
  }
  return body;
}

export class LineDecoder {
  #buffer = Buffer.alloc(0);
  #max;

  constructor({ max = MAX_IPC_REQUEST } = {}) {
    this.#max = max;
  }

  push(chunk) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.#buffer.length > this.#max) {
          throw new ProtocolError("frame_too_large", `IPC line exceeds ${this.#max} bytes.`);
        }
        return messages;
      }
      if (newline + 1 > this.#max) {
        throw new ProtocolError("frame_too_large", `IPC line exceeds ${this.#max} bytes.`);
      }
      const line = this.#buffer.subarray(0, newline).toString("utf8").trim();
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (!line) {
        continue;
      }
      try {
        messages.push(JSON.parse(line));
      } catch {
        throw new ProtocolError("bad_frame", "IPC line was not valid JSON.");
      }
    }
  }
}
