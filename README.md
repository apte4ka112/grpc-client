# grpc-client

**MCP-сервер — кнопка Send для native gRPC.**

Минимальный TypeScript MCP server (stdio) поверх `@grpc/grpc-js`. Один транспорт, unary вызовы.
Никакого глобального состояния в репо — конфигурация передаётся через `env` хост-проекта, лог пишется в `./.grpc-client/calls.jsonl` рядом с проектом.

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

## Подключение в хост-проекте (через npx)

`<host-project>/.mcp.json`:
```jsonc
{
  "mcpServers": {
    "grpc-client": {
      "command": "npx",
      "args": ["-y", "github:apte4ka112/grpc-client"],
      "env": {
        "GRPC_CLIENT_CONFIG": "{\"active\":\"dev\",\"profiles\":{\"dev\":{\"host\":\"grpc.dev.example.com:443\",\"proto\":{\"protoDir\":\"./node_modules/@your-org/api-client/proto\"},\"headers\":{\"x-csrf-token\":\"...\"},\"cookies\":{\"SHOP_SESSION_TOKEN\":\"...\"}}}}"
      }
    }
  }
}
```

При первом запуске npx склонирует репу и выполнит `prepare` (= `tsc`) — соберёт `dist/`. Дальше использует кэш.

### `GRPC_CLIENT_CONFIG`

`env` принимает **JSON-строку** с тем же шаблоном что и файл-конфиг:
```jsonc
{
  "active": "dev",
  "logLevel": "info",
  "profiles": {
    "dev": {
      "host": "grpc.dev.example.com:443",
      "proto": { "protoDir": "./node_modules/@your-org/api-client/proto" },
      "headers": { "x-csrf-token": "..." },
      "cookies": { "SHOP_SESSION_TOKEN": "..." },
      "timeoutMs": 30000
    },
    "prod": {
      "host": "grpc.example.com:443",
      "proto": { "protoDir": "./node_modules/@your-org/api-client/proto" },
      "headers": {},
      "cookies": {}
    }
  }
}
```

Несколько URL — несколько профилей в `profiles{}`. Per-call можно переключаться через `profile: "prod"` в `grpc_call`.

| Поле               | Что это                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| `host`             | `host:port`, всегда TLS                                                  |
| `proto.protoDir`   | Путь к корню `.proto`. Относительный — резолвится **от cwd**             |
| `headers`          | gRPC Metadata                                                            |
| `cookies`          | Seed-куки, склеиваются в `cookie:` metadata                              |
| `timeoutMs`        | Дедлайн на вызов (default 30000)                                         |

### Альтернатива: файл-конфиг

Если `GRPC_CLIENT_CONFIG` начинается **не** с `{`, его значение трактуется как путь к JSON-файлу.
Без env вообще ищется `./.grpc-client/config.json` от cwd. Файл-режим поддерживает hot-reload (mtime-кэш) — удобно при разработке.

### Лог запросов

`<host-project>/.grpc-client/calls.jsonl` — по одной JSON-строке на каждый `grpc_call` (включая `dryRun` и ошибки):
```json
{"ts":"2026-05-13T11:42:01.234Z","profile":"dev","target":"api.customer.v1.CustomerProfileAPI/GetNotifications","host":"grpc.dev.example.com:443","durationMs":142,"status":{"code":0,"name":"OK"},"request":{}}
{"ts":"2026-05-13T11:42:09.012Z","profile":"dev","target":"ProductAPI/GetProductShortForecast","host":"...","error":{"code":16,"status":"UNAUTHENTICATED","message":"invalid session"},"request":{"productIds":[1,2]}}
```

Полезно: `tail -f .grpc-client/calls.jsonl | jq .`

Добавь `.grpc-client/` в `.gitignore` хост-проекта.

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

1. `GRPC_CLIENT_CONFIG` env начинается с `{` → парсится как JSON.
2. `GRPC_CLIENT_CONFIG` env — путь к JSON-файлу.
3. `./.grpc-client/config.json` (от cwd).
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
- **profile switching:** менять `active` или передавать `profile: "..."` per call.
- **env-JSON режим:** конфиг фиксирован на старте процесса (env не меняется). Чтобы перечитать новые куки — рестарт MCP. Файл-режим перечитывает по mtime.
