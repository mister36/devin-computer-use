# devin-computer-use

## Layout

- `src/` — Node MCP server (`server.mjs`), CLI (`cli.mjs`), helper client, tools,
  browser bridge (`browser-protocol.mjs`, `browser-host.mjs`, `browser-client.mjs`,
  `browser-install.mjs`, `browser-tools.mjs`).
- `extension/` — MV3 Chrome extension (task-scoped browser control) loaded unpacked.
- `helper/`, `scripts/build-app.sh` — Swift helper app (requires macOS + TCC grants).
- `test/` — `node:test` unit tests; browser tests use fake Chrome APIs and temp
  unix sockets — no real Chrome, no helper app, no network.

## Verify

```sh
node --test test/browser-*.test.mjs
for f in extension/*.mjs; do node --check "$f" || exit 1; done
npm run lint && npm test
```

Never run `scripts/build-app.sh` without the user's approval — it replaces the
installed app and resets TCC grants. Never run `install-browser` against a real
home in tests; use temp-dir fixtures via the exported `installBrowser({home})`.
