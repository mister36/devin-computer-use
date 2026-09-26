---
name: browser-use
description: Use the Devin Chrome extension for task-scoped browser work while the user keeps using other windows.
---
# Browser tasks
Use the `computer-use` server's `browser_*` tools for Chrome websites. Keep the native app tools for native apps. Never fall back to desktop screenshots or app-level Chrome input when browser tools are unavailable; ask the user to connect the extension.

1. Call `browser_start_task` with a descriptive title and an HTTP(S) URL. If it already returns status "active" with tabs — the user enabled the extension's auto-approve setting — skip approval and use the returned tabs. Otherwise ask the user to approve the task in the Devin Browser Tasks extension, then check `browser_task_status`. Do not repeatedly poll for approval. Auto-approve does not authorize sensitive actions.
2. Use only the returned taskId and tabIds. `browser_open_tab` creates another tab in the task; existing personal tabs cannot be adopted.
3. Call `browser_state` for the target tab. Read its screenshot and accessibility text. Pass its observationId to input tools. Coordinates are screenshot pixels; scroll deltas are CSS pixels.
4. Each input returns a new observation. After navigation or a stale-observation error, observe again before acting. If a tab closes, leaves the group, or loses its debugger connection, stop and explain rather than choosing another tab.
5. Ask the user before sending messages, posting, purchasing, deleting, or other sensitive external actions. Extension task approval does not authorize those actions.
6. Finish with `browser_end_task`. This releases control but leaves tabs and their named group open.

Use `browser_type_text` after focusing the intended field with `browser_click`; it inserts text without selecting all or submitting. Supported keys are deliberately limited to page input, without browser shortcuts. Background sites may throttle media or pause stories; report that limitation rather than taking over the user's foreground window.

Setup: load this repository's `extension` directory as an unpacked Chrome extension, run `devin-computer-use install-browser --extension-id <extension-id>`, press Connect in the extension, and restart the MCP session to discover the browser tools. No remote debugging port or native-app Screen Recording permission is needed for this path.
