#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { constants, existsSync, realpathSync } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { HelperClient, defaultSocketPath } from "./helper-client.mjs";

const SERVER_NAME = "computer-use";
const SERVER_CONFIG = {
  command: "devin-computer-use-server",
  args: [],
};
const APP_NAME = "Devin Computer Use";
const BUILD_APP_SCRIPT = fileURLToPath(new URL("../scripts/build-app.sh", import.meta.url));

function usage() {
  console.log(`devin-computer-use

Usage:
  devin-computer-use install [--project] [--force]
  devin-computer-use doctor [--project]
  devin-computer-use uninstall [--project] [--force]
  devin-computer-use build-app
  devin-computer-use open-app
  devin-computer-use print-config

Options:
  --project  Use .devin/mcp_config.json in the current project.
  --force    Replace or remove a custom computer-use MCP entry.`);
}

export function userConfigPath({
  home = homedir(),
  os = platform(),
  appData = process.env.APPDATA,
} = {}) {
  if (os === "win32") {
    const root = appData || win32.join(home, "AppData", "Roaming");
    return win32.join(root, "devin", "mcp_config.json");
  }
  return posix.join(home, ".config", "devin", "mcp_config.json");
}

export function configPath({ project = false, cwd = process.cwd() } = {}) {
  return project
    ? resolve(cwd, ".devin", "mcp_config.json")
    : userConfigPath();
}

export function mergeServerConfig(config, { force = false } = {}) {
  const existing = config.mcpServers?.[SERVER_NAME];
  if (existing && !force && !isDeepStrictEqual(existing, SERVER_CONFIG)) {
    throw new Error(
      `An MCP server named "${SERVER_NAME}" already exists. Re-run with --force to replace it.`,
    );
  }

  return {
    ...config,
    mcpServers: {
      ...(config.mcpServers || {}),
      [SERVER_NAME]: SERVER_CONFIG,
    },
  };
}

export function removeServerConfig(config, { force = false } = {}) {
  const existing = config.mcpServers?.[SERVER_NAME];
  if (!existing) {
    return { config, removed: false };
  }
  if (!force && !isDeepStrictEqual(existing, SERVER_CONFIG)) {
    throw new Error(
      `The "${SERVER_NAME}" entry has custom settings. Re-run with --force to remove it.`,
    );
  }

  const mcpServers = { ...config.mcpServers };
  delete mcpServers[SERVER_NAME];
  return {
    config: {
      ...config,
      mcpServers,
    },
    removed: true,
  };
}

export function supportsNodeVersion(version) {
  const [major, minor] = version.split(".").map(Number);
  return (major === 20 && minor >= 19)
    || (major === 22 && minor >= 12)
    || major >= 23;
}

async function readConfig(path) {
  try {
    const source = await readFile(path, "utf8");
    const parsed = JSON.parse(source);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("the root value must be an object");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Cannot parse ${path}: ${error.message}`);
    }
    throw error;
  }
}

async function writeConfig(path, config) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  const contents = `${JSON.stringify(config, null, 2)}\n`;
  await writeFile(temporaryPath, contents, { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function install({ project, force }) {
  const path = configPath({ project });
  const config = await readConfig(path);
  const next = mergeServerConfig(config, { force });

  try {
    await access(path, constants.F_OK);
    await copyFile(path, `${path}.bak`);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  await writeConfig(path, next);
  console.log(`Installed ${SERVER_NAME} in ${path}`);
  console.log("Next: build and open the helper app: devin-computer-use build-app && devin-computer-use open-app");
  console.log("Grant Accessibility and Screen Recording to \"Devin Computer Use\" in System Settings.");
}

async function uninstall({ project, force }) {
  const path = configPath({ project });
  const current = await readConfig(path);
  const { config, removed } = removeServerConfig(current, { force });

  if (!removed) {
    console.log(`No ${SERVER_NAME} entry found in ${path}`);
    return;
  }

  await copyFile(path, `${path}.bak`);
  await writeConfig(path, config);
  console.log(`Removed ${SERVER_NAME} from ${path}`);
}

function findExecutable(command) {
  const locator = platform() === "win32" ? "where" : "which";
  try {
    return execFileSync(locator, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function mark(ok) {
  return ok ? "PASS" : "FAIL";
}

async function doctor({ project }) {
  let failed = false;
  const checks = [];
  const add = (ok, label, detail, { warn = false } = {}) => {
    checks.push({ ok, label, detail, warn });
    if (!warn) {
      failed ||= !ok;
    }
  };

  add(supportsNodeVersion(process.versions.node), "Node.js", process.version);

  const devin = findExecutable("devin");
  add(Boolean(devin), "Devin CLI", devin || "not found");

  const isMac = platform() === "darwin";
  add(isMac, "macOS", isMac ? "darwin" : `${platform()} (helper app requires macOS)`);

  const swift = findExecutable("swift");
  add(!isMac || Boolean(swift), "Xcode Command Line Tools (swift)", swift || "not found");

  const appPath = join(homedir(), "Applications", `${APP_NAME}.app`);
  add(!isMac || existsSync(appPath), "Helper app", existsSync(appPath) ? appPath : `missing at ${appPath}`);

  const bundledServer = join(appPath, "Contents", "Resources", "server", "src", "server.mjs");
  add(!isMac || existsSync(bundledServer), "Bundled MCP server",
    existsSync(bundledServer) ? bundledServer : "missing (re-run build-app)", { warn: true });

  const socket = process.env.DEVIN_COMPUTER_USE_SOCKET || defaultSocketPath();
  try {
    const client = new HelperClient({ socketPath: socket, launch: false });
    const pong = await client.request("ping", {}, { timeout: 5000 });
    client.close();
    add(true, "Helper socket", `${socket} (version ${pong?.version ?? "?"})`);
    add(Boolean(pong?.accessibility), "Accessibility permission", pong?.accessibility ? "granted" : "not granted");
    add(Boolean(pong?.screenRecording), "Screen Recording permission", pong?.screenRecording ? "granted" : "not granted");
  } catch (error) {
    add(false, "Helper socket", `${socket}: ${error.message}`);
  }

  const path = configPath({ project });
  try {
    const config = await readConfig(path);
    const installed = isDeepStrictEqual(config.mcpServers?.[SERVER_NAME], SERVER_CONFIG);
    add(installed, "MCP configuration", installed ? path : `missing or different in ${path}`);
  } catch (error) {
    add(false, "MCP configuration", error.message);
  }

  for (const check of checks) {
    const tag = check.ok ? "PASS" : check.warn ? "WARN" : "FAIL";
    console.log(`${tag}  ${check.label}: ${check.detail}`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

function runScript(args, { successMessage } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        if (successMessage) {
          console.log(successMessage);
        }
        resolvePromise();
      } else {
        reject(new Error(`${args[0]} exited with code ${code}`));
      }
    });
  });
}

async function openApp() {
  if (platform() !== "darwin") {
    throw new Error("open-app only works on macOS.");
  }
  const appPath = join(homedir(), "Applications", `${APP_NAME}.app`);
  await runScript(existsSync(appPath) ? ["open", appPath] : ["open", "-a", APP_NAME]);
  console.log(`Requested ${APP_NAME}. Look for the status icon in the menu bar.`);
}

function parseOptions(args) {
  return {
    project: args.includes("--project"),
    force: args.includes("--force"),
  };
}

async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  const options = parseOptions(args);

  if (command === "install") {
    await install(options);
  } else if (command === "doctor") {
    await doctor(options);
  } else if (command === "uninstall") {
    await uninstall(options);
  } else if (command === "build-app") {
    await runScript(["bash", BUILD_APP_SCRIPT]);
  } else if (command === "open-app") {
    await openApp();
  } else if (command === "print-config") {
    console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: SERVER_CONFIG } }, null, 2));
  } else if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else {
    usage();
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1]
  && process.argv[1] !== "-"
  && existsSync(process.argv[1])
  && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
