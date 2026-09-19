# Devin Computer Use

Give Devin CLI ChatGPT-style Computer Use on macOS: see and operate any app
through the OS accessibility layer instead of driving Chrome over CDP.

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
