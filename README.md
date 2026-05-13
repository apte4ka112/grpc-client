# grpc-client

**MCP-сервер — кнопка Send для native gRPC.**

Минимальный TypeScript MCP server (stdio) поверх `@grpc/grpc-js`. Один транспорт, unary вызовы.
Сам репозиторий **не хранит данных** — конфиг, токены, куки и лог запросов лежат в `.grpc-client/` хост-проекта.

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
             ▼
   <host-project>/.grpc-client/calls.jsonl   (append-only лог)
```

---

## Установка (репо)

```sh
cd /Users/movchan/grpc-client
npm install
npm run build
```

---

## Подключение в хост-проекте

В корне хост-проекта (там, где лежит его `package.json`) создаёшь папку `.grpc-client/` с двумя вещами:

```
<host-project>/
├── .grpc-client/
│   ├── config.json          ← профили, host, headers, cookies
│   └── calls.jsonl          ← (генерируется) append-only лог вызовов
└── .mcp.json                ← регистрация MCP-сервера
```

Минимальный `<host-project>/.mcp.json`:
```jsonc
{
  "mcpServers": {
    "grpc-client": {
      "command": "node",
      "args": ["/Users/movchan/grpc-client/dist/index.js"]
    }
  }
}
```
MCP запускается с `cwd` = корень хост-проекта, поэтому сам находит `./.grpc-client/config.json`.
Если конфиг лежит в другом месте — `env: { "GRPC_CLIENT_CONFIG": "/abs/path/config.json" }`.

### `config.json`

Пример: `examples/host-project-config.example.json`.

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
    }
  }
}
```

| Поле               | Что это                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `host`             | `host:port`, всегда TLS                                                            |
| `proto.protoDir`   | Путь к корню `.proto`. Относительный — резолвится **от директории config.json**    |
| `headers`          | gRPC Metadata                                                                      |
| `cookies`          | Seed-куки, склеиваются в `cookie:` metadata                                        |
| `timeoutMs`        | Дедлайн на вызов (default 30000)                                                   |

**Обновление куки/CSRF:** просто правишь `config.json`. Каждый `grpc_call` перечитывает файл — рестарт MCP не нужен.

### Лог запросов

`<host-project>/.grpc-client/calls.jsonl` — по одной JSON-строке на каждый `grpc_call` (включая `dryRun` и ошибки):
```json
{"ts":"2026-05-13T11:42:01.234Z","profile":"dev","target":"api.customer.v1.CustomerProfileAPI/GetNotifications","host":"grpc.dev.example.com:443","durationMs":142,"status":{"code":0,"name":"OK"},"request":{},"responseBytes":318}
{"ts":"2026-05-13T11:42:09.012Z","profile":"dev","target":"ProductAPI/GetProductShortForecast","host":"grpc.dev.example.com:443","error":{"code":16,"status":"UNAUTHENTICATED","message":"invalid session"},"request":{"productIds":[1,2]}}
```

Полезно: `tail -f .grpc-client/calls.jsonl | jq .` или `grep '"UNAUTHENTICATED"' .grpc-client/calls.jsonl`.

`.grpc-client/` стоит положить в `.gitignore` хост-проекта.

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
На ошибке: `{ "error": true, "code": N, "status": "...", "message": "..." }`.

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

## Discovery порядок

1. `GRPC_CLIENT_CONFIG=/abs/path/config.json` (env)
2. `./.grpc-client/config.json` (от cwd)
3. иначе — ошибка с подсказкой.

---

## Debug

```sh
GRPC_CLIENT_LOG_LEVEL=debug node dist/index.js
```
Или `"debug": true` в конфиге, или `"debug": true` per-call.
Логи pino (structured JSON) — в **stderr**; stdout зарезервирован под MCP protocol.

---

## Ограничения

- **Только unary RPC.** Streaming — намеренно не поддерживается.
- **Только TLS.** Plaintext gRPC и mTLS убраны.
- **Auth — через `headers`/`cookies`.** Никаких разных типов аутентификации в схеме.
- **Reflection не используется** — нужен локальный `.proto`.
- **profile switching:** менять `active` в `config.json` или передавать `profile: "..."` per call.
