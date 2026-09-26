import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { browserDir, HOST_NAME, installBrowser } from "../src/browser-install.mjs";

const ID = "a".repeat(32);
const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
const HOST = fileURLToPath(new URL("../src/browser-host.mjs", import.meta.url));
const DARWIN = { os: "darwin" };

async function mode(path) {
  return (await lstat(path)).mode & 0o777;
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), "dcu-install-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("installs wrapper, manifest and Chrome registration symlink", async () => {
  await withHome(async (home) => {
    const result = await installBrowser({ extensionId: ID, home, ...DARWIN });
    const wrapper = await readFile(result.wrapperPath, "utf8");
    assert.equal(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${HOST}' "$@"\n`);
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    assert.equal(manifest.name, HOST_NAME);
    assert.equal(manifest.type, "stdio");
    assert.equal(manifest.path, result.wrapperPath);
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    assert.equal(await mode(result.configDir), 0o700);
    assert.equal(await mode(result.wrapperPath), 0o700);
    assert.equal(await mode(result.manifestPath), 0o600);
    assert.equal(await readlink(result.registerPath), result.manifestPath);
    assert.match(result.registerPath, /Google\/Chrome\/NativeMessagingHosts\/ai\.devin\.browser\.json$/);
    assert.ok(result.extensionPath.endsWith("extension/"));
  });
});

test("quotes paths containing spaces and single quotes", async () => {
  await withHome(async (home) => {
    const nodePath = join(home, "my dir", "it's node");
    const hostPath = join(home, "host file.mjs");
    const result = await installBrowser({ extensionId: ID, home, nodePath, hostPath, ...DARWIN });
    const wrapper = await readFile(result.wrapperPath, "utf8");
    assert.equal(
      wrapper,
      `#!/bin/sh\nexec '${nodePath.replaceAll("'", "'\\''")}' '${hostPath}' "$@"\n`,
    );
  });
});

test("rerun with the same inputs is idempotent", async () => {
  await withHome(async (home) => {
    await installBrowser({ extensionId: ID, home, ...DARWIN });
    const again = await installBrowser({ extensionId: ID, home, ...DARWIN });
    assert.equal((await lstat(again.registerPath)).isSymbolicLink(), true);
  });
});

test("refuses to overwrite foreign files and changed extension ids", async () => {
  await withHome(async (home) => {
    const first = await installBrowser({ extensionId: ID, home, ...DARWIN });
    await assert.rejects(
      installBrowser({ extensionId: "b".repeat(32), home, ...DARWIN }),
      /Refusing to overwrite/,
    );
    const manifest = JSON.parse(await readFile(first.manifestPath, "utf8"));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
  });
  await withHome(async (home) => {
    const registerDir = join(
      home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts",
    );
    await installBrowser({ extensionId: ID, home, ...DARWIN });
    await rm(join(registerDir, `${HOST_NAME}.json`));
    await writeFile(join(registerDir, `${HOST_NAME}.json`), "{}");
    await assert.rejects(installBrowser({ extensionId: ID, home, ...DARWIN }), /Refusing to overwrite/);
  });
});

test("refuses symlinks and non-directory config paths without touching targets", async () => {
  await withHome(async (home) => {
    const target = join(home, "real-target.sh");
    await writeFile(target, `#!/bin/sh\nexec '${process.execPath}' '${HOST}' "$@"\n`);
    await mkdir(browserDir({ home }), { recursive: true });
    await symlink(target, join(browserDir({ home }), "native-host.sh"));
    await assert.rejects(installBrowser({ extensionId: ID, home, ...DARWIN }), /Refusing/);
    assert.equal((await lstat(target)).isFile(), true);
  });
  await withHome(async (home) => {
    await mkdir(browserDir({ home }), { recursive: true });
    await symlink(join(home, "missing-target"), join(browserDir({ home }), "native-host.sh"));
    await assert.rejects(installBrowser({ extensionId: ID, home, ...DARWIN }), /Refusing/);
    assert.equal(
      (await lstat(join(browserDir({ home }), "native-host.sh"))).isSymbolicLink(),
      true,
    );
  });
  await withHome(async (home) => {
    await mkdir(join(home, ".config", "devin"), { recursive: true });
    await writeFile(join(home, ".config", "devin", "browser"), "not a dir");
    await assert.rejects(installBrowser({ extensionId: ID, home, ...DARWIN }), /Refusing/);
  });
});

test("rejects invalid extension ids, relative paths, newline paths and non-macOS", async () => {
  await withHome(async (home) => {
    for (const extensionId of ["", "q".repeat(32), "abc", `${ID}\n`]) {
      await assert.rejects(
        installBrowser({ extensionId, home, ...DARWIN }),
        /extension-id|extension ID/i,
      );
    }
    await assert.rejects(
      installBrowser({ extensionId: ID, home: "relative/home", ...DARWIN }),
      /absolute/,
    );
    await assert.rejects(
      installBrowser({ extensionId: ID, home, nodePath: "/tmp/\nnode", ...DARWIN }),
      /newlines/,
    );
    await assert.rejects(
      installBrowser({ extensionId: ID, home, os: "linux" }),
      /macOS only/,
    );
  });
});

test("CLI install-browser reports missing extension id", () => {
  try {
    execFileSync(process.execPath, [CLI, "install-browser"], { encoding: "utf8", stdio: "pipe" });
    assert.fail("expected failure");
  } catch (error) {
    assert.match(String(error.stderr), /extension ID|--extension-id/);
  }
});

test("CLI usage lists install-browser", () => {
  const output = execFileSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.match(output, /install-browser --extension-id/);
});
