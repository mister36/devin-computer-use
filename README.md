# Devin Computer Use

Give Devin CLI ChatGPT-style Computer Use on macOS with two backends: the OS
accessibility layer for any native app, and a task-scoped Chrome extension for
websites (below).

A native desktop app uses the macOS Accessibility API (AXUIElement) to
read UI trees and trigger actions, screen capture for window screenshots, and
CGEvent synthetic input posted directly to the target process so it works in
the background without stealing your cursor. The tools are exposed to Devin as
an MCP server (`list_apps`, `get_app_state`, `click`, `type_text`,
`press_key`, `scroll`, `drag`, `open_app`, `wait`) plus an agent skill that
teaches the observe → act loop.

## Desktop app

`build-app` produces a ChatGPT-style desktop app: a chat window (sidebar of
conversations, streamed transcript, tool-call cards, inline permission prompts)
that talks to Devin CLI over the Agent Client Protocol — no terminal needed.
The MCP server is bundled inside the app, so chat works out of the box:

```sh
devin-computer-use build-app
devin-computer-use open-app
```

On first launch the app walks you through onboarding (Devin CLI installed,
signed in, Node.js, Accessibility, Screen Recording). Then chat: "list my
apps", "open Notes and write a grocery list". The app also keeps its menu-bar
icon and Unix socket for terminal-based Devin CLI — `devin-computer-use
install` remains optional for that flow.

`get_app_state` returns a compact, depth-limited AX tree with element indices
and a screenshot in a single call; later calls return only a diff of the tree.
Action tools return the post-action state, so "click and see what happened" is
a single model round trip. Approval is per app ("Allow Devin to use Notes?
Always allow"), not per tool call, and terminal applications are always
refused.

## Chrome browser tasks

For web work there is a second, task-scoped path: an unpacked Chrome extension
(`extension/`) plus a native messaging host (`src/browser-host.mjs`) that the
MCP server reaches over a Unix socket at
`~/.config/devin/browser/bridge.sock` (mode 0600). No remote debugging port and
no Screen Recording grant are needed.

Architecture: each MCP request travels `server → bridge.sock → Chrome's native
messaging → extension service worker`. The extension only ever touches tabs it
created for an approved task; your existing tabs are never adopted, and the
`browser_*` tools never fall back to the desktop AX path.

Setup:

```sh
# 1. Load extension/ as an unpacked extension in chrome://extensions and copy its ID.
# 2. Register the native host (writes ~/.config/devin/browser + a Chrome manifest symlink):
devin-computer-use install-browser --extension-id <extension-id>   # or: node src/cli.mjs install-browser ...
# 3. Open the Devin Browser Tasks popup and press Connect.
# 4. Restart your Devin/MCP session so the browser_* tools are registered.
```

Each `browser_start_task` appears in the extension popup; Devin can only use
the task after you press **Allow**. To skip that per-task approval, enable
**Auto-approve new tasks** in the popup — Devin still asks before sensitive
actions. Approved tasks open background tabs inside
a `Devin — <title>` tab group; `browser_state` returns a tab-targeted
screenshot plus a bounded accessibility tree, and input tools require the
latest `observationId`. If Chrome disconnects (extension reload, host exit),
all tasks are revoked — press Connect again and start fresh tasks; an MCP
restart is only needed to pick up new server code, not to reconnect the
extension. Only one Chrome profile can be connected to the bridge at a time.

Limitations: the debugger permission shows Chrome's "debugging this browser"
infobar while attached; sites in background tabs may throttle media or pause
stories; personal tabs can't be adopted; `browser_end_task` leaves the task's
tabs and group open. The desktop app's bundled MCP server predates these
tools — rebuilding it (`build-app`) to include them requires your approval
because it resets TCC grants.

## Requirements

- macOS 14+ with Xcode Command Line Tools (`xcode-select --install`)
- Node.js 20.19+ / 22.12+ / 24 and npm
- Devin CLI

## Install

```sh
git clone https://github.com/mister36/devin-computer-use.git
cd devin-computer-use
npm install
npm link
devin-computer-use build-app
devin-computer-use open-app
```

Grant **Accessibility** and **Screen Recording** to "Devin Computer Use" when
macOS prompts (System Settings → Privacy & Security). The helper lives in the
menu bar and talks to the MCP server over a local Unix socket.

Notes on the grants:

- Screen Recording takes effect only after **Quit & Reopen** of the helper
  (macOS requires it).
- On macOS 15+, the first capture shows a system "bypass the system private
  window picker" reminder — click **Allow**. It recurs periodically until the
  helper moves to `SCScreenshotManager`.
- Rebuilding the ad-hoc-signed app invalidates prior grants (TCC keys on the
  binary's cdhash); `build-app.sh` resets them so macOS prompts cleanly after
  the next launch. Signing with `CODESIGN_IDENTITY` avoids the reset.

```sh
devin-computer-use install    # writes the MCP entry into Devin's config
devin-computer-use doctor     # readiness check
```

Then start Devin CLI in any repository and ask it to, for example, "list my
apps" or "open Notes and write a grocery list". Tools appear as
`mcp__computer-use__*`.

## Project-only configuration

`install` writes the user-level Devin MCP config
(`~/.config/devin/mcp_config.json`). Use `--project` to write
`.devin/mcp_config.json` in the current repository instead:

```sh
devin-computer-use install --project
```

## Usage examples

```text
list_apps                          → apps with windows, bundle ids, pids
get_app_state {app:"Notes"}        → AX tree + window screenshot (diff after first call)
click {app:"Notes", elementId:4}   → click, settle, return post-action state
type_text {app:"Notes", text:"milk", submit:true}
press_key {app:"Notes", key:"s", modifiers:["cmd"]}
scroll {app:"Notes", dy:400}
wait {ms:500}
```

Every action accepts `observe:false` to skip the post-action state (batched
sequences) and `screenshot:false` for text-only results. `wait` is capped at
10 s. Prefer `elementId` from the last observation over `x,y`; coordinates are
screenshot pixels.

## Permissions & security

- The helper owns the TCC grants (Accessibility, Screen Recording). It serves
  a JSONL socket at `~/Library/Application Support/DevinComputerUse/helper.sock`
  (mode 0600).
- Per-app approval: the first time Devin touches an app the helper shows
  "Allow Devin to use \<app\>?" with Cancel / Allow / Always allow. The
  allowlist lives in `config.json` next to the socket and is editable from the
  menu bar ("Allowed apps…").
- Terminal apps (Terminal, iTerm2, Warp, Ghostty, Alacritty, kitty) are always
  refused (`blocked_app`), so Devin cannot type into a shell through this path.
- `install` does not add blanket `mcp__computer-use__*` permission; Devin still
  prompts per tool call. To pre-approve the read-only tools, allow
  `mcp__computer-use__list_apps`, `mcp__computer-use__get_app_state` and
  `mcp__computer-use__wait` individually in Devin's `permissions.allow` list.
- The app is ad-hoc signed by default (bundle id `ai.devin.computer-use.helper`);
  every rebuild changes the cdhash, so Accessibility and Screen Recording must
  be re-granted after `build-app` unless you set `CODESIGN_IDENTITY`. For
  distribution, sign with a
  Developer ID and notarize (`xcrun notarytool`); the bundle is not sandboxed
  because the Accessibility API requires it.

## Commands

```text
devin-computer-use install [--project] [--force]
devin-computer-use uninstall [--project] [--force]
devin-computer-use doctor [--project]
devin-computer-use build-app      # scripts/build-app.sh; honours CODESIGN_IDENTITY
devin-computer-use open-app
devin-computer-use print-config
```

The installer writes `mcp_config.json.bak` before changing an existing config
and refuses to replace or remove a customised `computer-use` entry unless you
pass `--force`.

## Uninstall

```sh
devin-computer-use uninstall
npm unlink --global devin-computer-use
rm -rf "$HOME/Applications/Devin Computer Use.app" \
       "$HOME/Library/Application Support/DevinComputerUse"
```

## Benchmark

`npm run bench` runs a scripted 10-step Chrome task through this server's tools
and through `chrome-devtools-mcp`, printing tool calls, bytes returned and
wall-clock. macOS only; `--dry-run` prints the plan.

## Design

See [docs/DESIGN.md](docs/DESIGN.md) for the protocol, tool surface, tree/diff
formats, approval model and repo layout.
