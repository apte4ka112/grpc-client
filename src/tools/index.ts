import { z } from 'zod'
import { getProfile, type LoadedConfig } from '../config/loader.js'
import { RuntimeOverridesSchema, type Profile, type RuntimeOverrides } from '../config/schema.js'
import { buildCookieString, callGrpc, describe, listServices } from '../grpc.js'
import { formatError } from '../utils/errors.js'
import { logger } from '../utils/logger.js'

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

export function buildTools(cfg: LoadedConfig): ToolDef[] {
  return [
    {
      name: 'grpc_call',
      description: 'Send a unary gRPC request. Per-call overrides (headers, cookies, timeout, host) take precedence over the profile. Returns JSON response with status, trailers and timing. dryRun: build the request without sending.',
      inputSchema: jsonSchema(GrpcCallArgs),
      handler: async input => {
        const a = GrpcCallArgs.parse(input)
        const { name: profileName, profile } = getProfile(cfg, a.profile)
        const merged = applyOverrides(profile, a)
        const metadata = { ...merged.headers }
        const cookieHeader = buildCookieString(merged.cookies)
        if (cookieHeader) metadata['cookie'] = cookieHeader
        const target = `${a.service}/${a.method}`
        if (a.dryRun) {
          return { dryRun: true, profile: profileName, host: merged.host, target, headers: metadata, cookieHeader, timeoutMs: merged.timeoutMs, data: a.data }
        }
        logger.info({ profile: profileName, target }, 'grpc_call')
        try {
          return await callGrpc({
            profileName,
            profile: merged,
            service: a.service,
            method: a.method,
            data: a.data,
            metadata,
            timeoutMs: merged.timeoutMs,
            debug: a.debug ?? cfg.data.debug
          })
        } catch (err) {
          return formatError(err)
        }
      }
    },
    {
      name: 'grpc_list_services',
      description: 'List services available on the active profile (proto file scan).',
      inputSchema: jsonSchema(ListServicesArgs),
      handler: async input => {
        const a = ListServicesArgs.parse(input)
        const { name: profileName, profile } = getProfile(cfg, a.profile)
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
        const { name: profileName, profile } = getProfile(cfg, a.profile)
        try {
          return { profile: profileName, ...describe(profile, a.service, a.method) }
        } catch (err) {
          return formatError(err)
        }
      }
    }
  ]
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
