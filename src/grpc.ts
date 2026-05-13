import * as grpc from '@grpc/grpc-js'
import protobuf, { type Type } from 'protobufjs'
import type { Profile } from './config/schema.js'
import {
  getServiceCtor,
  loadProto,
  resolveMethod,
  resolveService,
  type MethodMeta,
  type ServiceMeta
} from './proto/resolver.js'
import { logger } from './utils/logger.js'

export interface Streaming {
  client: boolean
  server: boolean
}

export interface MethodSummary {
  name: string
  request: string
  response: string
  streaming: Streaming
}

export interface ServiceListing {
  service: string
  methods: MethodSummary[]
}

export interface FieldInfo {
  type: string
  id: number
  repeated: boolean
  optional: boolean
  map: boolean
  oneof?: string
}

export interface MethodDescriptor {
  service: string
  method: string
  request: { name: string; fields: Record<string, FieldInfo> }
  response: { name: string; fields: Record<string, FieldInfo> }
  streaming: Streaming
  comment?: string | null
}

export interface CallResult {
  profile: string
  host: string
  target: string
  status: { code: number; name: string; message?: string }
  response: unknown
  trailers?: Record<string, string>
  durationMs: number
}

export interface CallInput {
  profileName: string
  profile: Profile
  service: string
  method: string
  data: Record<string, unknown>
  metadata: Record<string, string>
  timeoutMs: number
  debug: boolean
}

const clients = new Map<string, grpc.Client>()

export async function callGrpc(input: CallInput): Promise<CallResult> {
  const loaded = loadProto(input.profile.proto.protoDir)
  const svc = resolveService(loaded, input.service)
  const meta = resolveMethod(svc, input.method)
  if (meta.requestStream || meta.responseStream) {
    throw new Error(`streaming RPCs not supported: ${svc.fullName}/${input.method}`)
  }

  const ServiceCtor = getServiceCtor(loaded, svc.fullName)
  const target = normalizeTarget(input.profile.host)
  const cacheKey = `${input.profileName}|${target}`
  let client = clients.get(cacheKey)
  if (!client) {
    client = new ServiceCtor(target, grpc.credentials.createSsl())
    clients.set(cacheKey, client)
  }
  const methodFn = (client as unknown as Record<string, Function>)[input.method]
  if (typeof methodFn !== 'function') {
    throw new Error(`Method ${input.method} not found on client for ${svc.fullName}`)
  }

  const md = new grpc.Metadata()
  for (const [k, v] of Object.entries(sanitizeForGrpc(input.metadata))) md.set(k, v)

  const started = Date.now()
  return await new Promise<CallResult>((resolve, reject) => {
    const deadline = Date.now() + input.timeoutMs
    if (input.debug) logger.debug({ target, fullName: svc.fullName, method: input.method }, 'grpc call')
    methodFn.call(
      client,
      input.data,
      md,
      { deadline },
      (err: grpc.ServiceError | null, response: unknown, trailingMetadata?: grpc.Metadata) => {
        const durationMs = Date.now() - started
        if (err) {
          const trailers = metadataToObject(trailingMetadata ?? err.metadata)
          const wrapped = err as grpc.ServiceError & { trailers?: Record<string, string> }
          wrapped.trailers = trailers
          reject(wrapped)
          return
        }
        resolve({
          profile: input.profileName,
          host: input.profile.host,
          target: `${svc.fullName}/${input.method}`,
          status: { code: grpc.status.OK, name: grpc.status[grpc.status.OK] },
          response,
          trailers: trailingMetadata ? metadataToObject(trailingMetadata) : undefined,
          durationMs
        })
      }
    )
  })
}

export function listServices(profile: Profile): ServiceListing[] {
  const loaded = loadProto(profile.proto.protoDir)
  return [...loaded.services.values()].map(serviceListing)
}

export function describeService(profile: Profile, service: string): ServiceListing {
  const loaded = loadProto(profile.proto.protoDir)
  return serviceListing(resolveService(loaded, service))
}

export function describeMethod(profile: Profile, service: string, method: string): MethodDescriptor {
  const loaded = loadProto(profile.proto.protoDir)
  const svc = resolveService(loaded, service)
  const m = resolveMethod(svc, method)
  return {
    service: svc.fullName,
    method: m.name,
    request: { name: m.requestTypeName, fields: typeFields(loaded.root.lookupType(m.requestTypeName)) },
    response: { name: m.responseTypeName, fields: typeFields(loaded.root.lookupType(m.responseTypeName)) },
    streaming: { client: m.requestStream, server: m.responseStream },
    comment: m.comment
  }
}

export function closeAllClients(): void {
  for (const c of clients.values()) {
    try { c.close() } catch { /* noop */ }
  }
  clients.clear()
}

export function buildCookieString(seedCookies: Record<string, string>): string {
  if (!seedCookies) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(seedCookies)) {
    if (!k || v == null || v === '') continue
    parts.push(`${k}=${v}`)
  }
  return parts.join('; ')
}

function serviceListing(s: ServiceMeta): ServiceListing {
  return { service: s.fullName, methods: Object.values(s.methods).map(methodSummary) }
}

function methodSummary(m: MethodMeta): MethodSummary {
  return {
    name: m.name,
    request: m.requestTypeName,
    response: m.responseTypeName,
    streaming: { client: m.requestStream, server: m.responseStream }
  }
}

function normalizeTarget(host: string): string {
  const noScheme = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return /^dns:|^unix:|^ipv[46]:/.test(noScheme) ? noScheme : `dns:///${noScheme}`
}

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const NEWLINES = /[\r\n]/g
const FORBIDDEN_HEADERS = new Set(['content-type', 'content-length'])

function sanitizeForGrpc(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (!PRINTABLE_ASCII.test(k)) continue
    const lower = k.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower)) continue
    out[lower] = String(v).replace(NEWLINES, '')
  }
  return out
}

function metadataToObject(md: grpc.Metadata | undefined): Record<string, string> {
  if (!md) return {}
  const out: Record<string, string> = {}
  for (const [k, vs] of Object.entries(md.getMap())) {
    const arr = Array.isArray(vs) ? vs : [vs]
    out[k] = arr
      .map(v => (Buffer.isBuffer(v) ? v.toString('base64') : String(v)))
      .join(', ')
  }
  return out
}

function typeFields(T: Type | undefined): Record<string, FieldInfo> {
  const out: Record<string, FieldInfo> = {}
  if (!T?.fields) return out
  for (const [name, f] of Object.entries(T.fields) as Array<[string, protobuf.Field]>) {
    out[name] = {
      type: f.type,
      id: f.id,
      repeated: !!f.repeated,
      optional: !!f.optional,
      map: f instanceof protobuf.MapField,
      oneof: f.partOf?.name
    }
  }
  return out
}
