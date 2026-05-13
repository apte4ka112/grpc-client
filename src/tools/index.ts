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
      description: 'Send a unary gRPC request. Per-call overrides (headers, cookies, timeout, host) take precedence over the profile. Returns JSON response with status, trailers and timing. dryRun: build the request without sending. Every call is appended to .grpc-client/calls.jsonl.',
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
      description: 'List services available on the active profile (proto file scan).',
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
      description: 'Describe a method (request/response field tree). Omit method to describe the whole service.',
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
      description: 'Parse a curl command (e.g. Chrome DevTools Copy as cURL) and merge its headers and cookies into a profile in .grpc-client/config.json. By default does NOT touch host or protoDir — typical use is refreshing CSRF token and session cookies from a fresh browser request. Pass replace: true to overwrite headers/cookies instead of merging. Pass an explicit `host` string only when you intentionally want to retarget the profile. Requires file-config mode.',
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
    proto: ov.proto ?? base.proto
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
