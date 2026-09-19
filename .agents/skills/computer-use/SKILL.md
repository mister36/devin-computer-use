---
name: computer-use
description: See and operate any macOS app via the Devin Computer Use helper — prefer it over shell scripts or CDP when a task needs a real GUI, a native app, or apps without a debug protocol.
---

# Computer Use (macOS)

Drive macOS apps through the accessibility layer: read a compact AX tree plus a
window screenshot in one call, then act by element id or screenshot pixel
coordinates. Tools are exposed as `mcp__computer-use__*`.

## When to use
- Native macOS apps (Notes, Finder, Calendar, Slack, Electron apps, etc.) where
  there is no CDP or scripting bridge.
- Apps that must keep their real login/session or where attaching a debugger is
  not possible.
- Prefer shell/CLI/CDP when one exists and covers the task — computer use is
  the fallback for real GUI work.

## The observe → act loop
1. `list_apps` to find the target (name, bundle id, pid, window titles).
2. `get_app_state` for that app — returns the AX tree (element ids, roles,
   labels) **and** a screenshot in one call. Later calls return a tree diff.
3. Act: `click`, `type_text`, `press_key`, `scroll`, `drag`.
   Every action returns the post-action state (tree diff + screenshot), so
   "click and see what happened" is one round trip.
4. Repeat until done. If the tree diff says nothing changed, look at the
   screenshot and retry or pick a different element.

## Acting well
- **Prefer `elementId` over coordinates.** Ids come from the last
  `get_app_state`; they are per-observation — after the UI changes, call
  `get_app_state` again instead of reusing stale ids (stale ids error with
  `stale_element`).
- Coordinates (`x`, `y`, `from`, `to`) are **screenshot pixels** — read them
  off the returned image; the server maps them to window points.
- Use `observe: false` for known sequences (e.g. type, Tab, type, Return) to
  skip intermediate screenshots, then observe once at the end. Use
  `screenshot: false` when only the tree matters. Use `wait` when the UI needs
  time to settle.
- `type_text` with `replace: true` clears a field first; `submit: true` sends
  Return afterwards.
- `press_key` accepts names: `return`, `tab`, `escape`, `space`, `delete`,
  `up/down/left/right`, `f1`-`f12`, `a`-`z`, `0`-`9`, with `cmd/shift/alt/ctrl`
  modifiers — e.g. `key:"s", modifiers:["cmd"]` for Save.

## Limits and safety
- **Never operate terminals.** Terminal apps (Terminal, iTerm2, Warp, Ghostty,
  Alacritty, kitty) are always refused with `blocked_app` — run shell commands
  yourself instead.
- **Ask the user before irreversible or external actions**: sending messages or
  email, purchases, deleting files/data, posting publicly.
- **Approval**: the helper prompts "Allow Devin to use <app>?" per app. If a
  tool returns `app_not_allowed`, tell the user to allow the app in the Devin
  Computer Use menu-bar app (menu: Allowed apps…), then retry — do not retry in
  a tight loop.
- If `helper_unavailable`, ask the user to open the Devin Computer Use app, or
  run `devin-computer-use doctor` to diagnose.
