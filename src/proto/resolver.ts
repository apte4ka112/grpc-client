import fs from 'node:fs'
import path from 'node:path'
import protobuf from 'protobufjs'

export interface MethodMeta {
  name: string
  requestTypeName: string
  responseTypeName: string
  requestStream: boolean
  responseStream: boolean
  comment?: string | null
}

export interface ServiceMeta {
  pkg: string
  name: string
  fullName: string
  methods: Record<string, MethodMeta>
}

export interface LoadedProto {
  root: protobuf.Root
  services: Map<string, ServiceMeta>
  files: string[]
  rootDir: string
}

const cache = new Map<string, LoadedProto>()

export function loadProto(protoDir: string): LoadedProto {
  const key = path.resolve(protoDir)
  const hit = cache.get(key)
  if (hit) return hit

  if (!fs.existsSync(key)) throw new Error(`protoDir does not exist: ${key}`)

  const root = new protobuf.Root()
  root.resolvePath = (_origin, target) => {
    if (path.isAbsolute(target) && fs.existsSync(target)) return target
    const candidate = path.join(key, target)
    return fs.existsSync(candidate) ? candidate : target
  }

  const files = walk(key)
  if (files.length === 0) throw new Error(`No .proto files under ${key}`)
  root.loadSync(files)

  const services = collectServices(root)
  const loaded: LoadedProto = { root, services, files, rootDir: key }
  cache.set(key, loaded)
  return loaded
}

function collectServices(root: protobuf.Root): Map<string, ServiceMeta> {
  const services = new Map<string, ServiceMeta>()
  const visit = (ns: protobuf.ReflectionObject | null | undefined) => {
    if (!ns) return
    if (ns instanceof protobuf.Service) {
      const fullName = ns.fullName.replace(/^\./, '')
      const methods: Record<string, MethodMeta> = {}
      for (const m of Object.values(ns.methods)) {
        m.resolve()
        methods[m.name] = {
          name: m.name,
          requestTypeName: m.resolvedRequestType?.fullName?.replace(/^\./, '') ?? m.requestType,
          responseTypeName: m.resolvedResponseType?.fullName?.replace(/^\./, '') ?? m.responseType,
          requestStream: !!m.requestStream,
          responseStream: !!m.responseStream,
          comment: m.comment ?? null
        }
      }
      services.set(fullName, {
        pkg: fullName.replace(/\.[^.]+$/, ''),
        name: fullName.split('.').pop() as string,
        fullName,
        methods
      })
    }
    const nested = (ns as protobuf.NamespaceBase).nestedArray
    if (nested) for (const c of nested) visit(c)
  }
  visit(root)
  return services
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && p.endsWith('.proto')) out.push(p)
  }
  return out
}

export function resolveService(loaded: LoadedProto, input: string): ServiceMeta {
  if (loaded.services.has(input)) return loaded.services.get(input) as ServiceMeta
  const matches = [...loaded.services.values()].filter(s => s.name === input || s.fullName.endsWith('.' + input))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(`Service "${input}" is ambiguous: ${matches.map(m => m.fullName).join(', ')}`)
  }
  throw new Error(`Service "${input}" not found. Known: ${[...loaded.services.keys()].slice(0, 10).join(', ')}${loaded.services.size > 10 ? '...' : ''}`)
}

export function resolveMethod(svc: ServiceMeta, method: string): MethodMeta {
  const m = svc.methods[method]
  if (!m) throw new Error(`Method "${method}" not found on ${svc.fullName}. Available: ${Object.keys(svc.methods).join(', ')}`)
  return m
}
