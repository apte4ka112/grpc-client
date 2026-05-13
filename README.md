# grpc-client

**MCP-сервер — кнопка Send для native gRPC.**

Минимальный TypeScript MCP server (stdio) поверх `@grpc/grpc-js`. Один транспорт, unary вызовы, профили + per-call оверрайды на headers/cookies/timeout/host.

```
Claude / MCP client
        │ stdio
        ▼
┌──────────────────────────┐
│  MCP tools               │
│   grpc_call              │
│   grpc_list_services     │
│   grpc_describe_method   │
└────────────┬─────────────┘
             ▼
    src/grpc.ts (callGrpc / describe / listServices)
             ▼
        @grpc/grpc-js
```

---

## Установка

```sh
cd /Users/movchan/grpc-client
npm install
npm run build
```

Запуск:
```sh
node dist/index.js
npm run dev      # tsx watch
```

---

## Конфиг (`profiles.json`)

Путь: `./profiles.json` или `GRPC_CLIENT_CONFIG=/absolute/path`.

```jsonc
{
  "active": "dev",
  "debug": false,
  "logLevel": "info",
  "profiles": {
    "dev": {
      "host": "grpc.dev.example.com:443",
      "proto": { "protoDir": "/abs/path/to/proto/root" },
      "headers": { "x-metadata-language": "rus" },
      "cookies": {},
      "timeoutMs": 30000
    }
  }
}
```

### Поля профиля

| Поле               | Что это                                                        |
| ------------------ | -------------------------------------------------------------- |
| `host`             | `host:port`, всегда TLS                                        |
| `proto.protoDir`   | Корень с `.proto` (импорты резолвятся рекурсивно)              |
| `headers`          | gRPC Metadata                                                  |
| `cookies`          | Seed-куки, шлются как `cookie:` metadata                       |
| `timeoutMs`        | Дедлайн на вызов (default 30000)                               |

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

Ответ:
```json
{
  "profile": "dev",
  "host": "grpc.dev.example.com:443",
  "target": "catalog.CatalogService/GetProduct",
  "status": { "code": 0, "name": "OK" },
  "response": { "id": 123, "name": "..." },
  "trailers": { "grpc-status": "0" },
  "durationMs": 142
}
```

На ошибке возвращается `{ "error": true, "code": N, "status": "...", "message": "..." }`.

### `grpc_list_services`
```jsonc
{ "profile": "dev" }
```

### `grpc_describe_method`
```jsonc
{ "service": "catalog.CatalogService", "method": "GetProduct" }
```
Без `method` — список методов сервиса. С `method` — поля request/response с типами.

---

## Интеграция с Claude Desktop / Claude Code

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):
```jsonc
{
  "mcpServers": {
    "grpc-client": {
      "command": "node",
      "args": ["/Users/movchan/grpc-client/dist/index.js"],
      "env": {
        "GRPC_CLIENT_CONFIG": "/Users/movchan/grpc-client/profiles.json",
        "GRPC_CLIENT_LOG_LEVEL": "info"
      }
    }
  }
}
```

Для Claude Code положить тот же блок в `.mcp.json` или `~/.claude.json`. Для смены активного профиля — править `profiles.json` и рестарт MCP (или передавать `profile: "..."` в каждом вызове).

---

## Debug

```sh
GRPC_CLIENT_LOG_LEVEL=debug node dist/index.js
```
Или `"debug": true` в конфиге, или `"debug": true` per-call. Логи (pino structured JSON) — в stderr; stdout зарезервирован под MCP протокол.

---

## Структура

```
grpc-client/
├── src/
│   ├── index.ts           — entry
│   ├── server.ts          — MCP server (stdio)
│   ├── grpc.ts            — callGrpc / describe / listServices + cookies + sanitize
│   ├── config/
│   │   ├── schema.ts      — zod схемы
│   │   └── loader.ts      — loadConfig + getProfile (read-only)
│   ├── proto/resolver.ts  — рекурсивная загрузка .proto, кэш
│   ├── tools/index.ts     — 3 MCP tools + jsonSchema converter
│   └── utils/
│       ├── logger.ts      — pino → stderr
│       └── errors.ts      — formatError
├── examples/
│   ├── claude-desktop.json
│   ├── request.json
│   └── get-notifications.json
├── profiles.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## Ограничения

- **Только unary RPC.** Streaming — намеренно не поддерживается.
- **Только TLS.** Plaintext gRPC и mTLS убраны (можно вернуть при необходимости).
- **Auth — через `headers`/`cookies`.** Никаких разных типов аутентификации в схеме.
- **profile-switching:** не через MCP tool; править `profiles.json` или передавать `profile: "..."` в каждом вызове.
- **Reflection не используется** — нужен локальный `.proto`.
