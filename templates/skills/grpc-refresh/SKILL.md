---
name: grpc-refresh
description: Refresh expired gRPC session by importing a curl command from Chrome DevTools. Updates headers and cookies in the active profile of .grpc-client/config.json without restarting MCP. Trigger when the user says "обнови сессию", "обнови куки", "новый curl", "refresh grpc session", or when a previous grpc_call returned UNAUTHENTICATED / PERMISSION_DENIED.
---

# Refresh gRPC session from a DevTools curl

## When to invoke

- The user pasted a `curl '...' -H '...'` block, possibly preceded by a phrase like "обнови", "import this", "новые куки", "refresh".
- A recent `grpc_call` returned `code: 16` (UNAUTHENTICATED) or `code: 7` (PERMISSION_DENIED). Suggest this skill before retrying.

## Steps

1. If the user has NOT pasted a curl yet, tell them exactly:
   > Открой Chrome DevTools → Network → ПКМ по любому grpc-web запросу → Copy → Copy as cURL. Вставь сюда.
2. Once you see a curl command in the conversation, call `grpc_import_curl` with:
   - `curl`: the full pasted command (including `curl` and all `-H` flags)
   - `profile`: omit by default so the active profile is patched; pass an explicit name only if the user said "в профиль prod" / "into prod profile".
3. Do **not** pass `host` — the curl from a browser usually hits a frontend (e.g. `winestyle.ru`) while the actual gRPC endpoint (`grpc.winestyle.ru:443`) is already configured in `config.json`. Override host only if the user explicitly asks to retarget.
4. Read the tool's response and confirm to the user in 1 line: profile name, number of headers/cookies updated, and whether `hostChanged` is `true` (warn if so).
5. If the tool returns `error: true` with status `FAILED_PRECONDITION`, the server is running in env-JSON mode. Tell the user to run `npx github:apte4ka112/grpc-client init` in the project root and restart Claude Code.

## After import

The next `grpc_call` uses the new tokens automatically (config.json is hot-reloaded by mtime). If the user has a pending failed call, offer to retry it.
