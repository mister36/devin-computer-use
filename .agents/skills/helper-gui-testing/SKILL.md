---
name: helper-gui-testing
description: Run and test this repository's Swift chat helper from source without replacing the installed app or resetting macOS permissions.
---

# Testing the helper GUI from source

- On macOS, run `swift run DevinComputerUseHelper` from `helper/`; keep the shell process running during GUI tests.
- Do not run `scripts/build-app.sh` without explicit user approval: it replaces the installed app and may reset TCC grants.
- If native accessibility lookup cannot resolve the source-built executable by app name, obtain its PID with `pgrep -fl DevinComputerUseHelper` and inspect/act by PID.
- Onboarding has a **Continue anyway** button for testing local chat without all dependencies. Check the onboarding status rather than installing/signing in implicitly.
- A missing CLI permits testing local user messages and sidebar/composer interactions, but does not prove streamed echo reconciliation, assistant markdown, tool grouping, queue draining or active cancellation. Do not seed fake transcripts and call that end-to-end coverage.
- A source run does not bundle the MCP server. For real CLI-backed computer-use sessions, the code supports `DEVIN_COMPUTER_USE_SERVER` pointing at the repository's `src/server.mjs`.
- Maximize the GUI using the native window control before recording. Dismiss unrelated OS notifications before capturing transcript evidence.

## Devin Secrets Needed

None for local-only GUI checks. Full assistant turns require an installed, authenticated Devin CLI; verify `devin auth status` without exposing credential values.
