# grpc-client

**MCP-сервер — кнопка Send для native gRPC.**

Минимальный TypeScript MCP server (stdio) поверх `@grpc/grpc-js`. Один транспорт, unary вызовы.
Никакого глобального состояния в репо — конфигурация лежит в `.grpc-client/config.json` хост-проекта, лог пишется рядом.

```
Claude / MCP client
        │ stdio
        ▼
┌──────────────────────────┐
│  MCP tools               │
│   grpc_call              │
│   grpc_list_services     │
│   grpc_describe_method   │
│   grpc_import_curl       │
└────────────┬─────────────┘
             ▼
    src/grpc.ts (callGrpc / describe / listServices)
             ▼
        @grpc/grpc-js
             ▼
   <host-project>/.grpc-client/
       config.json   (профили — hot-reload по mtime)
       calls.jsonl   (append-only лог)
```

---

## Quickstart

В корне хост-проекта:

```sh
npx github:apte4ka112/grpc-client init
```

Эта команда:
- создаёт `.grpc-client/config.json` (auto-detect `protoDir` в `node_modules/**/proto`),
- добавляет блок `grpc-client` в `.mcp.json` (создаст файл если нет),
- добавляет `.grpc-client/` в `.gitignore`.

Получившийся `.mcp.json`:
```jsonc
{
  "mcpServers": {
    "grpc-client": {
      "command": "npx",
      "args": ["github:apte4ka112/grpc-client"]
    }
  }
}
```

Никаких секретов в `.mcp.json`. Конфиг с токенами — в локальном `.grpc-client/config.json` (gitignored).

Дальше открой `.grpc-client/config.json` и заполни `host` + первые `headers`/`cookies`, или сразу импортируй curl из DevTools через `grpc_import_curl` (см. ниже). Перезапусти Claude Code чтобы он подцепил MCP.

---

## `.grpc-client/config.json`

```jsonc
{
  "active": "dev",
  "logLevel": "info",
  "profiles": {
    "dev": {
      "host": "grpc.dev.example.com:443",
      "proto": { "protoDir": "../node_modules/@your-org/api-client/proto" },
      "headers": { "x-csrf-token": "..." },
      "cookies": { "SHOP_SESSION_TOKEN": "..." },
      "timeoutMs": 30000
    },
    "prod": {
      "host": "grpc.example.com:443",
      "proto": { "protoDir": "../node_modules/@your-org/api-client/proto" },
      "headers": {},
      "cookies": {}
    }
  }
}
```

| Поле               | Что это                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `host`             | gRPC endpoint в формате `host:port`, всегда TLS                            |
| `proto.protoDir`   | Корень `.proto`. Относительный — резолвится **от директории config.json**  |
| `headers`          | gRPC Metadata                                                              |
| `cookies`          | Seed-куки, склеиваются в `cookie:` metadata                                |
| `timeoutMs`        | Дедлайн на вызов (default 30000)                                           |

**Hot-reload:** файл перечитывается по mtime — после правки куки/csrf просто сохрани файл, рестарт MCP не нужен.

---

## Импорт curl из DevTools

В Chrome DevTools → Network → правый клик по grpc-web запросу → **Copy → Copy as cURL**. Вставь в чат и попроси Claude:

> «Импортируй этот curl в профиль dev: `curl 'https://winestyle.ru/...' -H '...' ...`»

Тул `grpc_import_curl` распарсит и **смерджит** headers + cookies в существующий профиль. По умолчанию **не трогает `host`** и `proto.protoDir` — потому что curl из браузера обычно идёт на frontend (`winestyle.ru`), а реальный gRPC-бэкенд — другой (`grpc.winestyle.ru:443`), и он у тебя уже прописан в `config.json` правильно.

Опции тула:
- `profile: string` — в какой профиль слить (default: `active`).
- `replace: boolean` (default `false`) — `true` заменит `headers`/`cookies` целиком, не мерджа.
- `updateHost: boolean` (default `false`) — `true` возьмёт `host` из URL curl'а.
- `host: string` — явно задать целевой host (приоритет над `updateHost`).

---

## MCP tools

### `grpc_call`
```jsonc
{
  "profile": "dev",                       // optional, default = active
  "service": "catalog.CatalogService",    // short name или FQN
  "method": "GetProduct",
  "data": { "id": 123 },

  // per-call overrides:
  "host": "grpc.override.example.com:443",
  "headers": { "x-trace-id": "abc" },
  "cookies": { "session": "xyz" },
  "timeoutMs": 5000,
  "proto": { "protoDir": "/tmp/other-protos" },
  "debug": true,
  "dryRun": false
}
```

Ответ: `{ profile, host, target, status: {code, name}, response, trailers, durationMs }`.
На ошибке: `{ error: true, code, status, message, trailers? }`.

### `grpc_list_services`
```jsonc
{ "profile": "dev" }
```

### `grpc_describe_method`
```jsonc
{ "service": "catalog.CatalogService", "method": "GetProduct" }
```
Без `method` — список методов сервиса.

### `grpc_import_curl`
```jsonc
{ "curl": "curl '...' -H '...' ...", "profile": "dev" }
```

---

## Лог запросов

`<host-project>/.grpc-client/calls.jsonl` — по одной JSON-строке на каждый `grpc_call` (включая `dryRun` и ошибки):
```json
{"ts":"2026-05-13T11:42:01.234Z","profile":"dev","target":"...","host":"grpc.dev.example.com:443","durationMs":142,"status":{"code":0,"name":"OK"},"request":{}}
{"ts":"2026-05-13T11:42:09.012Z","profile":"dev","target":"...","host":"...","error":{"code":16,"status":"UNAUTHENTICATED","message":"invalid session"},"request":{"productIds":[1,2]}}
```

`tail -f .grpc-client/calls.jsonl | jq .`

---

## Discovery порядок

1. `GRPC_CLIENT_CONFIG` env начинается с `{` → парсится как inline JSON.
2. `GRPC_CLIENT_CONFIG` env — путь к JSON-файлу.
3. `./.grpc-client/config.json` (от cwd, дефолт после `init`).
4. иначе — ошибка с подсказкой.

---

## Локальная разработка

```sh
cd /Users/movchan/grpc-client
npm install        # запускает prepare → tsc → dist/
npm run dev        # tsx watch
```

Запуск напрямую: `node dist/index.js`.

---

## Debug

`GRPC_CLIENT_LOG_LEVEL=debug`, либо `"debug": true` в конфиге, либо `"debug": true` per-call.
Логи pino (structured JSON) — в **stderr**; stdout зарезервирован под MCP protocol.

---

## Ограничения

- **Только unary RPC.** Streaming — намеренно не поддерживается.
- **Только TLS.** Plaintext gRPC и mTLS убраны.
- **Auth — через `headers`/`cookies`.** Никаких разных типов аутентификации в схеме.
- **Reflection не используется** — нужен локальный `.proto`.
- **`grpc_import_curl` работает только в file-config режиме** (после `init`). В env-JSON режиме конфиг иммутабельный.
