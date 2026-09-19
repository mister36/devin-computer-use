# devin-computer-use — Design

Give Devin CLI ChatGPT-style Computer Use on macOS: see and operate any app
through the OS accessibility layer instead of driving Chrome over CDP.

## How ChatGPT does it (what we mimic)

- Native helper app (`SkyComputerUseClient.app`) uses **Accessibility
  (AXUIElement)** to read UI trees and trigger actions, **screen capture** for
  window screenshots, and **CGEvent** synthetic input posted to the target
  process so it works in the background without stealing the user's cursor.
- Exposed to the model as an **MCP server + skill** with ~10 coarse tools:
  `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`, `scroll`,
  `drag`, `open_app`, ...
- `get_app_state` returns a compact, depth-limited AX tree with element indices
  **and** a screenshot in one call; later calls return only a **diff** of the
  tree. Action tools return the post-action state, so "click and see what
  happened" is a single model round trip.
- Approval is **per app** ("Allow Codex to use Calculator? Always allow"), not
  per tool call.

## Components

```
Devin CLI ──stdio MCP──▶ Node MCP server (src/server.mjs)
                              │ JSONL over Unix socket
                              ▼
                 Devin Computer Use.app  (menu-bar app, Swift)
                    AXUIElement · CGWindowList/ScreenCaptureKit · CGEvent
```

1. **`helper/`** — Swift package `DevinComputerUse` building a menu-bar `.app`.
   Owns the TCC permissions (Accessibility, Screen Recording), shows a status
   icon while a task drives an app, hosts the per-app *Allow / Always allow*
   prompt, and serves requests on `~/Library/Application Support/DevinComputerUse/helper.sock`.
2. **`src/server.mjs`** — Node MCP stdio server (`@modelcontextprotocol/sdk`).
   Connects to the socket (launching the app with `open -a` if needed),
   exposes the tools, does AX-tree diffing and coordinate mapping.
3. **`src/cli.mjs`** — `devin-computer-use install|uninstall|doctor|build-app|print-config`.
   Writes the MCP entry into Devin's `mcp_config.json` (user or `--project`
   scope), same safe-merge/backup behaviour as devin-local-chrome.
4. **`.agents/skills/computer-use/SKILL.md`** — teaches Devin the
   observe → act loop and when to prefer this over shell/CDP.
5. **`bench/`** — same 10-step task via chrome-devtools-mcp vs this server,
   printing tool calls, bytes and wall-clock.

## Helper protocol (JSONL, one request per line)

Request: `{"id":1,"method":"get_app_state","params":{...}}`
Response: `{"id":1,"result":{...}}` or `{"id":1,"error":{"code":"...","message":"..."}}`

| method | params | result |
|---|---|---|
| `ping` | — | `{version, accessibility: bool, screenRecording: bool}` |
| `list_apps` | — | `{apps:[{pid, name, bundleId, active, windows:[{id, title, bounds}]}]}` |
| `get_app_state` | `{app, windowId?, screenshot?: bool (default true), maxNodes?, maxDepth?}` | `{app:{pid,name,bundleId}, window:{id,title,bounds}, elements:[Element], screenshot?:{png(base64), width, height, scale}}` |
| `click` | `{app, elementId? \| x?,y?, button?: left/right, count?: 1/2}` | `{ok}` |
| `type_text` | `{app, text, elementId?, replace?: bool, submit?: bool}` | `{ok}` |
| `press_key` | `{app, key, modifiers?: ["cmd","shift","alt","ctrl"]}` | `{ok}` |
| `scroll` | `{app, elementId? \| x?,y?, dx, dy}` | `{ok}` |
| `drag` | `{app, from:{x,y}, to:{x,y}}` | `{ok}` |
| `open_app` | `{app}` | `{pid}` |
| `set_value` | `{app, elementId, value}` | `{ok}` |

`app` is a bundle id (`com.apple.Notes`), an app name (`Notes`) or a pid.
Every method except `ping`/`list_apps`/`open_app` first passes the **approval
gate**: if the app is not in the always-allowed set the helper shows an
NSAlert *"Allow Devin to use Notes?"* [Cancel] [Allow] [Always allow]. Denial
returns error code `app_not_allowed`. Terminal apps (Terminal, iTerm2, Warp,
Ghostty, Alacritty, kitty) are always refused (`blocked_app`) as ChatGPT does.

### Element

```json
{"id": 12, "role": "button", "label": "Save", "value": null, "bounds": [x,y,w,h],
 "depth": 3, "focused": false, "enabled": true, "actions": ["press"]}
```

- `id` is an index into the flattened tree for this observation only. The
  helper keeps the `AXUIElement` refs of the last observation per app so the
  next `click {elementId}` resolves to the live element (falls back to bounds
  center if the element is gone → error `stale_element`).
- Roles are normalised (`AXButton`→`button`, `AXStaticText`→`text`,
  `AXTextField`→`textfield`, ...). Purely structural nodes (`AXGroup`,
  `AXSplitGroup`, generic web `group`s) with no label/value are **collapsed**;
  their children are promoted.
- Defaults `maxDepth: 25`, `maxNodes: 600`; the result carries `truncated: true`
  when hit. For Chromium/Electron apps the helper sets `AXEnhancedUserInterface`
  and `AXManualAccessibility` on the app element so web content is exposed.
- `bounds` are **window-relative points**. Coordinates in `click/scroll/drag`
  use the same space, so a coordinate read from the screenshot is valid after
  dividing by `screenshot.scale` (the server does this when the model passes
  `x,y` in screenshot pixels — see server).

### Screenshot

Window-only capture (`CGWindowListCreateImage` with the window id; move to
`SCScreenshotManager` later). Downscaled so the long edge ≤ 1280px, PNG,
`scale` = png px / window points.

### Input

- `click`: prefer `AXPress` when the element supports it and `count == 1`
  (fully background-safe). Otherwise post `CGEvent` mouse down/up with
  `postToPid(pid)` at the screen point; this delivers to the app without moving
  the real cursor. Does not activate the app.
- `type_text`: focus the element (`AXFocused = true`) when given; then post
  keyboard CGEvents with `keyboardSetUnicodeString` per chunk to the pid.
  `replace: true` selects all first (or sets `AXValue` directly if the element
  supports it). `submit: true` presses Return afterwards.
- `press_key`: `key` is a name (`return`, `tab`, `escape`, `space`, `delete`,
  `up/down/left/right`, `f1..f12`, `a`..`z`, `0`..`9`) with modifier flags.
- `scroll`: `CGEvent(scrollWheelEvent2Source:)` with pixel units at the point,
  posted to pid.
- `drag`: mouse down, a few interpolated moves, mouse up, posted to pid.

## MCP tools (server)

Names as Devin will see them: `mcp__computer-use__<tool>`.

| tool | notes |
|---|---|
| `list_apps` | plain text table: name, bundle id, pid, windows |
| `get_app_state {app, fullTree?: bool, screenshot?: bool}` | Text block with the tree (or `Δ` diff since the last state for that app: `+`/`-`/`~` lines) followed by an image block. Diff is used automatically when the previous tree exists and `fullTree` isn't set; the text always starts with `window: … (N elements, diff|full)`. |
| `click {app, elementId? \| x?,y?, button?, count?}` | performs action, waits `settleMs` (default 300), then returns `get_app_state` (diff + screenshot). |
| `type_text {app, text, elementId?, replace?, submit?}` | same post-action state |
| `press_key {app, key, modifiers?}` | same |
| `scroll {app, dx, dy, elementId? \| x?,y?}` | same |
| `drag {app, from, to}` | same |
| `open_app {app}` | launches/activates, returns state |
| `wait {ms}` | capped at 10 000 |

Every action tool accepts `observe: false` to skip the post-action state for
batched sequences, and `screenshot: false` to return text only.

Tree text format (one element per line, indentation = depth):

```
window: Notes — "Groceries" (312 elements, full)
[3] toolbar
  [4] button "New Note" 
  [7] textfield "Search" value=""
[12] textarea "Note body" value="milk\neggs" focused
```

Diff format:

```
window: Notes — "Groceries" (314 elements, diff vs previous)
+ [88] text "Saved" 
- [12] textarea "Note body" value="milk\neggs"
~ [12] textarea "Note body" value="milk\neggs\nbread"
```

Diff keys elements by `(role,label,path-of-labelled-ancestors)`; ids are
re-issued each observation and the server maps old→new for the `~` lines.

## Approval model

- Helper-side per-app allowlist persisted in
  `~/Library/Application Support/DevinComputerUse/config.json`
  (`{"alwaysAllowed": ["com.apple.Notes"], "blocked": [...]}`), editable from the
  menu bar ("Allowed apps…").
- Devin CLI side: `install` does **not** add blanket `mcp__computer-use__*`
  permission. README documents how to allow the read-only tools
  (`list_apps`, `get_app_state`, `wait`) and, optionally, the rest once the
  helper's per-app gate is trusted.

## Chat window (ChatGPT-style desktop UI)

The app is a regular windowed app (dock icon + menu-bar status item, no
`LSUIElement`). The main window mimics the ChatGPT desktop app so all
computer-use work happens inside it, never in a terminal:

- `NavigationSplitView`: sidebar of conversations (title = first user message,
  persisted as JSON under `~/Library/Application Support/DevinComputerUse/conversations/`),
  transcript in the middle, composer at the bottom ("Work with Devin", send /
  Stop button, "Approve for me" toggle, model label = "Devin CLI").
- The transcript renders: user bubbles, streamed assistant text, tool-call
  cards (title, status spinner/check, kind icon; expanded content shows text
  and image blocks — screenshots returned by `computer-use` tools appear as
  thumbnails), plan entries, and inline permission cards.
- Devin is embedded through the **Agent Client Protocol**: the app spawns
  `devin acp` as a child process and speaks JSON-RPC 2.0 (newline-delimited)
  over its stdin/stdout:
  - `initialize {protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}}`
  - `session/new {cwd, mcpServers:[{name:"computer-use", command:<node>, args:[<server.mjs>], env:[]}]}`
    — the MCP server is bundled at `Contents/Resources/server/` (src/, node_modules/, package.json)
    so no `devin-computer-use install` step is required for the app.
  - `session/prompt {sessionId, prompt:[{type:"text",text}]}` → response `{stopReason}` ends the turn.
  - Agent → client notifications `session/update` with `sessionUpdate` in
    `agent_message_chunk | user_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan | usage_update | available_commands_update | current_mode_update`.
    Devin CLI 3000.10.x also sends `config_option_update` (ignored) and
    `session_info_update {title}` (adopted as the conversation title), plus
    vendor notifications `_cognition.ai/*` (ignored).
  - Agent → client request `session/request_permission {toolCall, options:[{optionId,name,kind}]}`;
    the app answers `{outcome:{outcome:"selected",optionId}}` (or `cancelled` after
    `session/cancel`). With "Approve for me" on, the app auto-picks the first
    `allow_always` option, else `allow_once`.
  - `session/cancel` on Stop. If `agentCapabilities.loadSession` is true a
    reopened conversation calls `session/load`; otherwise it starts a fresh session.
    The CLI answers `session/load` with `-32016 Session not found` for sessions it
    no longer has (observed for sessions created without credentials), in which
    case the app falls back to `session/new` and keeps the local transcript.
    Unauthenticated, `initialize`/`session/new` succeed (the MCP server is even
    spawned) and `session/prompt` fails with `-32000 Please log in to use Devin`.
- Helper per-app approval ("Allow Devin to use Safari?") is shown as an inline
  card in the active conversation when the window is open, falling back to the
  `NSAlert` otherwise. The socket thread blocks on a semaphore until answered.
- Onboarding pane (shown until every check passes): Devin CLI found
  (`~/.local/bin/devin` or `command -v devin` via `/bin/zsh -lc`), signed in
  (`devin auth status` output — it exits 0 even when "Not logged in"), Node
  found, Accessibility, Screen Recording.
  Each row has a fix button: "Install Devin CLI" runs
  `curl -fsSL https://cli.devin.ai/install.sh | bash` in-app with streamed
  output; "Sign in" opens Terminal with `devin auth login` (needs a TTY);
  permission rows open the matching System Settings pane.
- Toolchain discovery runs through `/bin/zsh -lc 'command -v node devin'`
  so Homebrew/nvm/volta paths work when launched from Finder.

## Distribution

- `npm run build:app` (`scripts/build-app.sh`) runs `swift build -c release`,
  assembles `Devin Computer Use.app` (regular windowed app —
  `NSAccessibilityUsageDescription`, bundle id `ai.devin.computer-use.helper`)
  and bundles the MCP server into `Contents/Resources/server/` (src/,
  package.json, production node_modules),
  ad-hoc signs it (`codesign --force --deep -s -`) and copies it to
  `~/Applications`. A stable bundle id + stable signing identity keeps TCC
  grants across rebuilds; ad-hoc signing means a rebuild can require re-granting.
- For sharing: sign with Developer ID + notarize (`scripts/notarize.sh`
  placeholder documenting `xcrun notarytool`). No sandbox (AX requires it off).
- Requirements: macOS 13+, Xcode CLT, Node 20.19+/22.12+/24.

## Repo layout

```
devin-computer-use/
  package.json  (bin: devin-computer-use, devin-computer-use-server)
  src/cli.mjs            installer / doctor
  src/server.mjs         MCP server entry
  src/helper-client.mjs  socket client, launch-on-demand, JSONL framing
  src/tree.mjs           formatTree, diffTrees, normalise
  src/tools.mjs          tool schemas + handlers (pure, testable with a fake client)
  helper/Package.swift
  helper/Sources/DevinComputerUseHelper/{main.swift, App.swift(window+menu bar), Server.swift(socket+JSONL),
        Accessibility.swift, Screenshot.swift, Input.swift, Approval.swift, Protocol.swift,
        Chat/{ACPClient.swift, ChatStore.swift, Toolchain.swift, Views/}}
  helper/Info.plist
  scripts/build-app.sh
  .agents/skills/computer-use/SKILL.md
  bench/run.mjs
  test/*.test.mjs        node:test, fake helper over a temp socket
  docs/DESIGN.md
  .github/workflows/ci.yml   (ubuntu: lint+test; macos: swift build)
```
