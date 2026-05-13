import fs from 'node:fs'
import { status as GrpcStatus } from '@grpc/grpc-js'
import { z } from 'zod'
import { getProfile, type LoadedConfig } from '../config/loader.js'
import { PACKAGE_REF } from '../config/paths.js'
import { RuntimeOverridesSchema, type Profile, type RuntimeOverrides } from '../config/schema.js'
import { buildCookieString, callGrpc, describeMethod, describeService, listServices } from '../grpc.js'
import { parseCurl } from '../cli/curl.js'
import type { CallLogEntry } from '../utils/calllog.js'
import { formatError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'
import { appendCallLog } from '../utils/calllog.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (input: unknown) => Promise<unknown>
}

const GrpcCallArgs = RuntimeOverridesSchema.extend({
  profile: z.string().optional(),
  service: z.string(),
  method: z.string(),
  data: z.record(z.unknown()).default({}),
  debug: z.boolean().optional(),
  dryRun: z.boolean().optional()
})

const ListServicesArgs = z.object({ profile: z.string().optional() })
const DescribeArgs = z.object({ profile: z.string().optional(), service: z.string(), method: z.string().optional() })
const ImportCurlArgs = z.object({
  curl: z.string(),
  profile: z.string().optional(),
  replace: z.boolean().default(false),
  host: z.string().optional()
})

export function buildTools(cfg: LoadedConfig): ToolDef[] {
  return [
    {
      name: 'grpc_call',
      description: [
        'Send a unary gRPC request. Use this whenever the user wants to invoke an RPC — phrases like "дёрни X", "сделай grpc запрос", "позови X", "вызови rpc", "посмотри данные на dev по X", "call X".',
        '',
        'WORKFLOW — follow every time:',
        '1. If the user named only a method (no service), call grpc_list_services first to locate it. If multiple services have the same method name, ask the user to pick.',
        '2. Unless you already inspected this exact method in the current conversation, call grpc_describe_method with the resolved service+method BEFORE calling this tool. You need the request schema to know required fields.',
        '3. From the schema identify required fields (NOT marked optional, NOT part of a oneof). If the user didn\'t provide values for any of them, ASK in chat — list field names with types compactly, e.g. "Методу нужен productIds: int64[] (repeated, required). Дай список ID через запятую." For repeated fields accept comma-separated input. Never invent values; if the user is vague, suggest dryRun: true.',
        '4. Call this tool. Default profile is `dev`; pass profile: "prod" ONLY when the user explicitly says "на проде" / "in prod", and ask once to confirm before the first prod call in the session.',
        '5. Show the result compactly: "OK · 142ms · response: {…top 1–3 keys…}". Don\'t dump huge payloads unless asked. Offer to drill into a field on request.',
        '',
        'STRICT HOST RULE — read carefully:',
        '- The target host comes ONLY from the active profile in .grpc-client/config.json (or the per-call `host` arg if the user explicitly passed one in THIS message).',
        '- NEVER substitute the host from the curl URL, from an error message, from a previous request, or from inference. The curl URL is a frontend (e.g. winestyle.ru / dev.frontend...) — it is NEVER a valid gRPC host.',
        '- If a call fails with TLS error / self-signed cert / UNAVAILABLE / DNS issue: report the host and the error to the user, then STOP. Do NOT try a different host. Do NOT "try via curl host". Ask the user what to do.',
        '- The only way the host changes mid-conversation is if the user types it explicitly ("позови на проде", "host: foo.bar:443"). Otherwise: use the profile, no exceptions.',
        '',
        'ERROR ACTIONS (after the strict host rule above):',
        '- code 0 OK: success.',
        '- code 3 INVALID_ARGUMENT: re-fetch the schema, point out what\'s wrong, ask the user to correct.',
        '- code 7 PERMISSION_DENIED / code 16 UNAUTHENTICATED: session is stale. Tell the user "Куки протухли. Вставь свежий curl из DevTools — я обновлю сессию через grpc_import_curl." Do NOT retry automatically.',
        '- code 12 UNIMPLEMENTED: wrong method on this service. List methods available on the service. Do NOT switch hosts.',
        '- code 14 UNAVAILABLE / TLS / DNS / certificate errors: report verbatim, name the host that was tried, and STOP. Don\'t guess alternatives. Ask the user.',
        '- other codes: surface message + trailers.',
        '',
        'ANTI-BAN HYGIENE: all headers/cookies from the active profile are sent as-is. Don\'t strip user-agent / origin / referer. No rapid-fire retries on errors — one call per user intent.',
        '',
        'PER-CALL OVERRIDES (use only when user asks): host, headers, cookies, timeoutMs, proto. dryRun: true previews without sending. Every call is appended to .grpc-client/calls.jsonl.'
      ].join('\n'),
      inputSchema: jsonSchema(GrpcCallArgs),
      handler: async input => {
        const a = GrpcCallArgs.parse(input)
        const data = cfg.read()
        const { name: profileName, profile } = getProfile(data, a.profile)
        const merged = applyOverrides(profile, a)
        const metadata = { ...merged.headers }
        const cookieHeader = buildCookieString(merged.cookies)
        if (cookieHeader) metadata['cookie'] = cookieHeader
        const target = `${a.service}/${a.method}`
        const base: CallLogEntry = {
          ts: new Date().toISOString(),
          profile: profileName,
          target,
          host: merged.host,
          request: a.data
        }
        if (a.dryRun) {
          appendCallLog(cfg.dataDir, { ...base, dryRun: true })
          return { dryRun: true, profile: profileName, host: merged.host, target, headers: metadata, cookieHeader, timeoutMs: merged.timeoutMs, data: a.data }
        }
        logger.info({ profile: profileName, target }, 'grpc_call')
        try {
          const result = await callGrpc({
            profileName,
            profile: merged,
            service: a.service,
            method: a.method,
            data: a.data,
            metadata,
            timeoutMs: merged.timeoutMs,
            debug: a.debug ?? data.debug
          })
          appendCallLog(cfg.dataDir, {
            ...base,
            durationMs: result.durationMs,
            status: result.status
          })
          return result
        } catch (err) {
          const formatted = formatError(err)
          appendCallLog(cfg.dataDir, {
            ...base,
            error: { code: formatted.code, status: formatted.status, message: formatted.message }
          })
          return formatted
        }
      }
    },
    {
      name: 'grpc_list_services',
      description: 'List gRPC services parsed from the profile\'s proto tree. Trigger on "покажи сервисы", "что доступно", "list services", or when grpc_call needs to disambiguate a method that exists in multiple services.',
      inputSchema: jsonSchema(ListServicesArgs),
      handler: async input => {
        const a = ListServicesArgs.parse(input)
        const data = cfg.read()
        const { name: profileName, profile } = getProfile(data, a.profile)
        try {
          const services = listServices(profile)
          return { profile: profileName, count: services.length, services }
        } catch (err) {
          return formatError(err)
        }
      }
    },
    {
      name: 'grpc_describe_method',
      description: 'Describe a service or one of its methods. Omit `method` to list methods on a service; pass both to get request/response field shapes. Always call this before grpc_call (unless you inspected the same method earlier in this conversation) — the request.fields map drives the "ask user for missing required fields" step.',
      inputSchema: jsonSchema(DescribeArgs),
      handler: async input => {
        const a = DescribeArgs.parse(input)
        const data = cfg.read()
        const { name: profileName, profile } = getProfile(data, a.profile)
        try {
          const result = a.method
            ? describeMethod(profile, a.service, a.method)
            : describeService(profile, a.service)
          return { profile: profileName, ...result }
        } catch (err) {
          return formatError(err)
        }
      }
    },
    {
      name: 'grpc_import_curl',
      description: [
        'Parse a curl command and merge its headers + cookies into a profile in .grpc-client/config.json. Use this whenever:',
        '- The user pastes a `curl \'...\' -H \'...\'` block in chat (with or without an explicit instruction — pasted curl is the signal).',
        '- The user says "обнови сессию", "обнови куки", "новый curl", "refresh session".',
        '- A previous grpc_call returned UNAUTHENTICATED (16) or PERMISSION_DENIED (7) — ask for a fresh curl from DevTools and then call this.',
        '',
        'WORKFLOW:',
        '1. If no curl is in the conversation, tell the user: "Открой Chrome DevTools → Network → ПКМ по любому grpc-web запросу → Copy → Copy as cURL. Вставь сюда."',
        '2. Once a curl is in chat, call with `curl` = the full pasted command. Omit `profile` to patch the active one; pass an explicit name only if the user said "в профиль prod".',
        '3. Do NOT pass `host` — curl from the browser usually hits the frontend (e.g. winestyle.ru) while the actual gRPC endpoint (grpc.winestyle.ru:443) is already configured. Override host only when the user explicitly asks to retarget.',
        '4. Confirm in 1 line: profile, count of headers/cookies updated, and whether hostChanged is true (warn if so).',
        '',
        'After import, the next grpc_call uses the new tokens automatically (config.json hot-reloads by mtime). If a call failed earlier with stale auth, offer to retry it.',
        '',
        'Args: curl (required); profile (default = active); replace (default false — true overwrites instead of merging headers/cookies); host (optional explicit override).',
        '',
        'Returns FAILED_PRECONDITION if MCP is running in env-JSON mode (config came from GRPC_CLIENT_CONFIG env, not a file). In that case tell the user to drop the env var and re-init via `npx github:apte4ka112/grpc-client init`.'
      ].join('\n'),
      inputSchema: jsonSchema(ImportCurlArgs),
      handler: async input => {
        const a = ImportCurlArgs.parse(input)
        if (cfg.source !== 'file' || !cfg.filePath) {
          return precondition(`grpc_import_curl works only in file-config mode. Re-init with \`npx ${PACKAGE_REF} init\` (drop GRPC_CLIENT_CONFIG env from .mcp.json).`)
        }
        try {
          const parsed = parseCurl(a.curl)
          const raw = JSON.parse(fs.readFileSync(cfg.filePath, 'utf8'))
          raw.profiles = raw.profiles ?? {}
          const profileName = a.profile ?? raw.active
          if (!profileName) return precondition('no profile name (config has no active, none passed)')
          const existing = raw.profiles[profileName]
          if (!existing) {
            return precondition(`Profile "${profileName}" not found. Add it with host + proto.protoDir first, then re-run grpc_import_curl.`)
          }
          const nextHeaders = a.replace ? parsed.headers : { ...(existing.headers ?? {}), ...parsed.headers }
          const nextCookies = a.replace ? parsed.cookies : { ...(existing.cookies ?? {}), ...parsed.cookies }
          const nextHost = a.host ?? existing.host
          raw.profiles[profileName] = { ...existing, host: nextHost, headers: nextHeaders, cookies: nextCookies }
          atomicWriteJson(cfg.filePath, raw)
          return {
            profile: profileName,
            curlUrl: parsed.url,
            curlHost: parsed.host,
            profileHost: nextHost,
            hostChanged: nextHost !== existing.host,
            headersUpdated: Object.keys(parsed.headers).length,
            cookiesUpdated: Object.keys(parsed.cookies).length,
            action: a.replace ? 'replaced' : 'merged'
          }
        } catch (err) {
          return formatError(err)
        }
      }
    }
  ]
}

function precondition(message: string) {
  return formatError(Object.assign(new Error(message), { code: GrpcStatus.FAILED_PRECONDITION }))
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, filePath)
}

function applyOverrides(base: Profile, ov: RuntimeOverrides): Profile {
  return {
    host: ov.host ?? base.host,
    timeoutMs: ov.timeoutMs ?? base.timeoutMs,
    headers: { ...base.headers, ...(ov.headers ?? {}) },
    cookies: { ...base.cookies, ...(ov.cookies ?? {}) },
    proto: ov.proto ?? base.proto,
    insecureSkipVerify: base.insecureSkipVerify
  }
}

function jsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToSchema(schema) as Record<string, unknown>
}

function zodToSchema(s: z.ZodTypeAny): unknown {
  if (s instanceof z.ZodObject) {
    const shape = s.shape as Record<string, z.ZodTypeAny>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [k, v] of Object.entries(shape)) {
      properties[k] = zodToSchema(v)
      if (!v.isOptional() && !(v instanceof z.ZodDefault)) required.push(k)
    }
    const out: Record<string, unknown> = { type: 'object', properties }
    if (required.length) out.required = required
    return out
  }
  if (s instanceof z.ZodString) return { type: 'string' }
  if (s instanceof z.ZodNumber) return { type: 'number' }
  if (s instanceof z.ZodBoolean) return { type: 'boolean' }
  if (s instanceof z.ZodArray) return { type: 'array', items: zodToSchema(s.element) }
  if (s instanceof z.ZodRecord) return { type: 'object', additionalProperties: zodToSchema(s.valueSchema) }
  if (s instanceof z.ZodOptional) return zodToSchema(s.unwrap())
  if (s instanceof z.ZodDefault) return zodToSchema(s.removeDefault())
  if (s instanceof z.ZodEnum) return { type: 'string', enum: s.options }
  if (s instanceof z.ZodNullable) return zodToSchema(s.unwrap())
  if (s instanceof z.ZodAny || s instanceof z.ZodUnknown) return {}
  return {}
}
