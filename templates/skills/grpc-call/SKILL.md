---
name: grpc-call
description: Make a gRPC call via the grpc-client MCP — discover services, inspect a method's request shape, ask the user for any missing required fields, and invoke the method. Trigger when the user says "дёрни ручку X", "сделай grpc запрос", "позови X", "вызови rpc", "посмотри данные на dev по X", "покажи методы сервиса", "опиши метод".
---

# Guided gRPC call

The user will never call tools manually. They speak naturally: «дёрни GetNotifications», «посмотри корзину на dev», «покажи методы ProductAPI». Translate that intent into the right MCP tool sequence and ask follow-up questions in the chat when something is missing.

## Routing

| User intent | Action |
|---|---|
| List what's available | `grpc_list_services` |
| Inspect a service | `grpc_describe_method` with only `service` |
| Inspect a method | `grpc_describe_method` with `service` + `method` |
| Make the call | follow «Calling a method» below |
| Preview without sending | call flow + `dryRun: true` on `grpc_call` |

## Calling a method (the main flow)

Always follow these steps in order:

### 1. Resolve the service

If the user named only a method (e.g. «позови GetCart»), call `grpc_list_services` and find which service exposes a method with that name. If multiple services match, ask the user to pick:
> Нашёл `GetCart` в `api.cart.v1.CartAPI` и `api.checkout.v1.CheckoutAPI`. Какой?

### 2. Fetch the request schema

Always call `grpc_describe_method` with the resolved `service` and `method` **before** `grpc_call`, unless the user already supplied a complete payload AND you've called this method earlier in the same conversation.

The response contains `request.fields` — a map of `name → { type, id, repeated, optional, map, oneof }`.

A field is **required** when `optional` is `false` AND it is not part of a `oneof` group. Fields with primitive scalar types (`string`, `int64`, etc.) without `optional: true` are required. Enum types are required unless marked optional.

### 3. Collect missing required fields from the chat

Compare the user's stated values to the required field list. For any required field the user didn't provide:

- Print a compact summary of what's needed, e.g.:
  > Методу `ProductAPI.GetProductShortForecast` нужны:
  > - `productIds: int64[]` *(repeated, required)*
  > - `regionId: int32` *(optional)*
  >
  > Дай `productIds` — список ID через запятую.

- For up to 4 enum-typed fields or yes/no flags use AskUserQuestion (cleaner UX).
- For free-form values (IDs, strings, numbers) just ask in chat.
- If a field is `repeated`, accept comma-separated input and turn it into an array.
- If a field is a nested message, ask for it as a JSON object literal or break it down further.

Never invent values. If the user offers a vague hint («ну какой-нибудь товар»), suggest using `dryRun: true` instead of guessing.

### 4. Confirm and call

Once you have everything, restate the call in 1 line and then call `grpc_call`:

```
→ grpc_call service=ProductAPI method=GetProductShortForecast data={productIds: [267881, 18274]}
```

Pass:
- `service`: short name or FQN
- `method`: exact name
- `data`: object matching the schema
- `profile`: pass only if the user explicitly named one («в prod», «на стейдже»); otherwise let it default to active (typically `dev`)
- `dryRun: true` only when the user asks to preview

### 5. Show the result

Render compactly:
- On success: `OK · 142ms · response: {...первые 1-3 ключа...}`. Don't dump huge payloads unless asked. Offer to drill into a field on request.
- On error: render `code · STATUS · message` and act on it (see error table below).

## Error handling

| Code | Status | Action |
|---|---|---|
| 0 | OK | success |
| 3 | INVALID_ARGUMENT | re-fetch the schema, list what's wrong, ask the user to correct |
| 7 | PERMISSION_DENIED | session is stale or wrong region. Tell the user: «Куки протухли. Запусти `grpc-refresh` и вставь свежий curl.» Don't retry automatically. |
| 12 | UNIMPLEMENTED | wrong method or wrong host. List available methods on the service. |
| 14 | UNAVAILABLE | network/server issue. Show host, suggest retry. |
| 16 | UNAUTHENTICATED | same as 7 — invoke `grpc-refresh`. |
| other | — | surface `message` and `trailers` |

## Anti-bans / hygiene

- All headers and cookies from the imported curl are sent **as-is** (user-agent, origin, referer, x-csrf-token) — the request looks exactly like a real browser request. Don't strip them.
- Default profile is `dev`. Never silently switch to `prod`. If the user says «на проде» explicitly, pass `profile: "prod"` and ask once to confirm before sending the first prod call in the session.
- No rapid-fire retries on errors. One call per user intent.

## Tips

- Per-call overrides are allowed in `grpc_call` (`headers`, `cookies`, `timeoutMs`, `host`). Use them only for one-offs at the user's request.
- All calls are appended to `.grpc-client/calls.jsonl` automatically.
