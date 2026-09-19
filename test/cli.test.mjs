import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  mergeServerConfig,
  removeServerConfig,
  supportsNodeVersion,
  userConfigPath,
} from "../src/cli.mjs";

test("uses the documented Devin CLI user config paths", () => {
  assert.equal(
    userConfigPath({ home: "/Users/ada", os: "darwin" }),
    "/Users/ada/.config/devin/mcp_config.json",
  );
  assert.equal(
    userConfigPath({ home: "C:\\Users\\Ada", os: "win32", appData: "C:\\Users\\Ada\\AppData\\Roaming" }),
    "C:\\Users\\Ada\\AppData\\Roaming\\devin\\mcp_config.json",
  );
});

test("merges the computer-use server without removing other servers", () => {
  const config = mergeServerConfig({
    mcpServers: {
      github: { command: "github-mcp" },
    },
  });

  assert.deepEqual(config.mcpServers.github, { command: "github-mcp" });
  assert.deepEqual(config.mcpServers["computer-use"], {
    command: "devin-computer-use-server",
    args: [],
  });
});

test("requires force before replacing a different computer-use server", () => {
  assert.throws(
    () => mergeServerConfig({ mcpServers: { "computer-use": { command: "custom" } } }),
    /--force/,
  );
});

test("removes only the computer-use server", () => {
  const initial = mergeServerConfig({
    mcpServers: {
      github: { command: "github-mcp" },
    },
  });
  const { config, removed } = removeServerConfig(initial);

  assert.equal(removed, true);
  assert.deepEqual(config.mcpServers, { github: { command: "github-mcp" } });
});

test("preserves a custom server unless removal is explicitly forced", () => {
  const custom = {
    mcpServers: {
      "computer-use": { command: "custom-wrapper", args: ["--flag"] },
      github: { command: "github-mcp" },
    },
  };
  const original = structuredClone(custom);
  assert.throws(() => removeServerConfig(custom), /--force/);
  assert.deepEqual(custom, original);
  const { config, removed } = removeServerConfig(custom, { force: true });
  assert.equal(removed, true);
  assert.deepEqual(config.mcpServers, { github: { command: "github-mcp" } });
});

test("recognizes managed settings after property reordering", () => {
  const config = mergeServerConfig({});
  const server = config.mcpServers["computer-use"];
  config.mcpServers["computer-use"] = {
    args: server.args,
    command: server.command,
  };
  assert.doesNotThrow(() => mergeServerConfig(config));
  assert.equal(removeServerConfig(config).removed, true);
});

test("supports the documented Node versions", () => {
  for (const version of ["20.19.0", "22.12.0", "24.21.0"]) {
    assert.equal(supportsNodeVersion(version), true, version);
  }
  for (const version of ["18.20.0", "20.18.0", "21.7.0", "22.11.0"]) {
    assert.equal(supportsNodeVersion(version), false, version);
  }
});

test("runs through the symlink created by npm link", {
  skip: process.platform === "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "devin-computer-use-"));
  try {
    const executable = join(directory, "devin-computer-use");
    await symlink(fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), executable);
    const output = execFileSync(process.execPath, [executable, "print-config"], {
      encoding: "utf8",
    });
    const config = JSON.parse(output);
    assert.equal(config.mcpServers["computer-use"].command, "devin-computer-use-server");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("imports exported helpers without starting the CLI", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-"], {
    encoding: "utf8",
    input: `import { supportsNodeVersion } from ${JSON.stringify(new URL("../src/cli.mjs", import.meta.url).href)};
console.log(supportsNodeVersion("24.21.0"));`,
  });
  assert.equal(output, "true\n");
});
