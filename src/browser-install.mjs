import { chmod, lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HOST_NAME = "ai.devin.browser";
const EXTENSION_ID_RE = /^[a-p]{32}$/;

export function browserDir({ home = homedir() } = {}) {
  return join(home, ".config", "devin", "browser");
}

function shellQuote(value) {
  if (/[\n\r]/.test(value)) {
    throw new Error("Paths must not contain newlines.");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function requirePath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  if (/[\n\r]/.test(value)) {
    throw new Error(`${name} must not contain newlines.`);
  }
  return value;
}

async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

function ownedByMe(stat) {
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

export async function installBrowser({
  extensionId,
  home = homedir(),
  nodePath = process.execPath,
  hostPath = fileURLToPath(new URL("./browser-host.mjs", import.meta.url)),
  os = platform(),
} = {}) {
  if (typeof extensionId !== "string" || !EXTENSION_ID_RE.test(extensionId)) {
    throw new Error(
      "install-browser requires --extension-id with the 32-character Chrome extension ID (letters a-p).",
    );
  }
  if (os !== "darwin") {
    throw new Error("install-browser currently supports macOS only.");
  }
  requirePath(home, "home");
  requirePath(nodePath, "nodePath");
  requirePath(hostPath, "hostPath");

  const configDir = browserDir({ home });
  const wrapperPath = join(configDir, "native-host.sh");
  const manifestPath = join(configDir, `${HOST_NAME}.json`);
  const registerDir = join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
  );
  const registerPath = join(registerDir, `${HOST_NAME}.json`);

  const wrapper = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(hostPath)} "$@"\n`;
  const manifest = `${JSON.stringify({
    name: HOST_NAME,
    description: "Devin Browser Tasks native messaging host.",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }, null, 2)}\n`;

  const conflicts = [];
  const writes = [];

  const dirStat = await lstatOrNull(configDir);
  if (dirStat && (!dirStat.isDirectory() || dirStat.isSymbolicLink() || !ownedByMe(dirStat))) {
    conflicts.push(`${configDir} exists but is not a directory owned by this user.`);
  }

  for (const [path, contents] of [[wrapperPath, wrapper], [manifestPath, manifest]]) {
    const stat = await lstatOrNull(path);
    if (!stat) {
      writes.push([path, contents]);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || !ownedByMe(stat)) {
      conflicts.push(`${path} exists but is not a regular file owned by this user.`);
      continue;
    }
    if ((await readFile(path, "utf8")) !== contents) {
      conflicts.push(`${path} exists with different contents.`);
    }
  }

  const registerStat = await lstatOrNull(registerPath);
  let registerManaged = false;
  if (registerStat) {
    if (!registerStat.isSymbolicLink()
        || !ownedByMe(registerStat)
        || (await readlink(registerPath)) !== manifestPath) {
      conflicts.push(`${registerPath} already exists and is not a Devin-managed symlink.`);
    } else {
      registerManaged = true;
    }
  }
  if (conflicts.length) {
    throw new Error(`Refusing to overwrite existing files:\n${conflicts.join("\n")}`);
  }

  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  for (const [path, contents] of writes) {
    await writeFile(path, contents, { flag: "wx", mode: path === wrapperPath ? 0o700 : 0o600 });
  }
  await chmod(wrapperPath, 0o700);
  await chmod(manifestPath, 0o600);
  await mkdir(registerDir, { recursive: true });
  if (!registerManaged) {
    await symlink(manifestPath, registerPath);
  }

  return {
    configDir,
    wrapperPath,
    manifestPath,
    registerPath,
    extensionPath: fileURLToPath(new URL("../extension/", import.meta.url)),
  };
}
