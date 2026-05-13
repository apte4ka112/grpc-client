import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type { Type } from 'protobufjs'
import type { Profile } from './config/schema.js'
import { loadProto, resolveMethod, resolveService, type LoadedProto } from './proto/resolver.js'
import { logger } from './utils/logger.js'

export interface ServiceListing {
  service: string
  methods: Array<{ name: string; request: string; response: string; streaming: 'req' | 'resp' | 'req+resp' | null }>
}

export interface MethodDescriptor {
  service: string
  method: string
  request: { name: string; fields: Record<string, unknown> }
  response: { name: string; fields: Record<string, unknown> }
  streaming: { client: boolean; server: boolean }
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
const ctorCache = new Map<string, any>()

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
    client = new ServiceCtor(target, grpc.credentials.createSsl()) as grpc.Client
    clients.set(cacheKey, client)
  }

  const md = new grpc.Metadata()
  for (const [k, v] of Object.entries(sanitizeForGrpc(input.metadata))) md.set(k, v)

  const started = Date.now()
  return await new Promise<CallResult>((resolve, reject) => {
    const deadline = Date.now() + input.timeoutMs
    const call = (client as any)[input.method].bind(client) as Function
    if (input.debug) logger.debug({ target, fullName: svc.fullName, method: input.method }, 'grpc call')
    call(input.data, md, { deadline }, (err: grpc.ServiceError | null, response: any, trailingMetadata?: grpc.Metadata) => {
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
        status: { code: 0, name: 'OK' },
        response,
        trailers: trailingMetadata ? metadataToObject(trailingMetadata) : undefined,
        durationMs
      })
    })
  })
}

export function listServices(profile: Profile): ServiceListing[] {
  const loaded = loadProto(profile.proto.protoDir)
  return [...loaded.services.values()].map(s => ({
    service: s.fullName,
    methods: Object.values(s.methods).map(m => ({
      name: m.name,
      request: m.requestTypeName,
      response: m.responseTypeName,
      streaming: streamingTag(m.requestStream, m.responseStream)
    }))
  }))
}

export function describe(profile: Profile, service: string, method?: string): MethodDescriptor | ServiceListing {
  const loaded = loadProto(profile.proto.protoDir)
  const svc = resolveService(loaded, service)
  if (!method) {
    return {
      service: svc.fullName,
      methods: Object.values(svc.methods).map(m => ({
        name: m.name,
        request: m.requestTypeName,
        response: m.responseTypeName,
        streaming: streamingTag(m.requestStream, m.responseStream)
      }))
    }
  }
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

function getServiceCtor(loaded: LoadedProto, fullName: string): any {
  const key = `${loaded.rootDir}|${fullName}`
  const hit = ctorCache.get(key)
  if (hit) return hit
  const pkgDef = protoLoader.loadSync([...loaded.files], {
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [loaded.rootDir]
  })
  const grpcObj: any = grpc.loadPackageDefinition(pkgDef)
  const ctor = traverse(grpcObj, fullName)
  if (!ctor) throw new Error(`Service ctor not found for ${fullName}`)
  ctorCache.set(key, ctor)
  return ctor
}

function traverse(root: any, fullName: string): any | null {
  let cur = root
  for (const p of fullName.split('.')) {
    if (!cur || !cur[p]) return null
    cur = cur[p]
  }
  return cur
}

function normalizeTarget(host: string): string {
  const noScheme = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return /^dns:|^unix:|^ipv[46]:/.test(noScheme) ? noScheme : `dns:///${noScheme}`
}

function sanitizeForGrpc(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (!/^[\x21-\x7e]+$/.test(k)) continue
    if (k.toLowerCase() === 'content-type' || k.toLowerCase() === 'content-length') continue
    out[k.toLowerCase()] = String(v).replace(/[\r\n]/g, '')
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

function streamingTag(req: boolean, resp: boolean): 'req' | 'resp' | 'req+resp' | null {
  if (req && resp) return 'req+resp'
  if (req) return 'req'
  if (resp) return 'resp'
  return null
}

function typeFields(T: Type | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!T?.fields) return out
  for (const [name, f] of Object.entries<any>(T.fields)) {
    out[name] = {
      type: f.type,
      id: f.id,
      repeated: !!f.repeated,
      optional: !!f.optional,
      map: !!f.map,
      oneof: f.partOf?.name
    }
  }
  return out
}
