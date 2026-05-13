import fs from 'node:fs'
import path from 'node:path'
import { ConfigSchema, type Config, type Profile } from './schema.js'

const DIR_NAME = '.grpc-client'
const FILE_NAME = 'config.json'

export interface LoadedConfig {
  source: 'env-json' | 'file'
  filePath?: string
  dataDir: string
  read(): Config
}

export function loadConfig(explicit?: string): LoadedConfig {
  const raw = explicit ?? process.env.GRPC_CLIENT_CONFIG
  if (raw && raw.trim().startsWith('{')) {
    return loadInline(raw)
  }
  return loadFromFile(explicit)
}

function loadInline(jsonString: string): LoadedConfig {
  const cwd = process.cwd()
  const dataDir = path.join(cwd, DIR_NAME)
  let cached: Config | null = null

  const read = (): Config => {
    if (cached) return cached
    cached = parseAndResolve(jsonString, cwd)
    return cached
  }

  read() // fail fast
  return { source: 'env-json', dataDir, read }
}

function loadFromFile(explicit?: string): LoadedConfig {
  const resolved = explicit
    ? path.resolve(explicit)
    : path.resolve(process.cwd(), DIR_NAME, FILE_NAME)
  const configDir = path.dirname(resolved)
  const dataDir = path.basename(configDir) === DIR_NAME
    ? configDir
    : path.join(configDir, DIR_NAME)

  let cached: { mtimeMs: number; data: Config } | null = null

  const read = (): Config => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error(
          `Config not found: ${resolved}. ` +
            `Set GRPC_CLIENT_CONFIG to either a JSON config string or an absolute path, ` +
            `or create ./${DIR_NAME}/${FILE_NAME}.`
        )
      }
      throw err
    }
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.data
    const data = parseAndResolve(fs.readFileSync(resolved, 'utf8'), configDir)
    cached = { mtimeMs: stat.mtimeMs, data }
    return data
  }

  read() // fail fast
  return { source: 'file', filePath: resolved, dataDir, read }
}

function parseAndResolve(jsonString: string, baseDir: string): Config {
  const parsed = ConfigSchema.parse(JSON.parse(jsonString))
  if (!parsed.profiles[parsed.active]) {
    throw new Error(`Active profile "${parsed.active}" missing from profiles.`)
  }
  for (const [name, p] of Object.entries(parsed.profiles)) {
    parsed.profiles[name] = { ...p, proto: { protoDir: path.resolve(baseDir, p.proto.protoDir) } }
  }
  return parsed
}

export function getProfile(cfg: Config, name?: string): { name: string; profile: Profile } {
  const target = name ?? cfg.active
  const profile = cfg.profiles[target]
  if (!profile) {
    throw new Error(`Profile "${target}" not found. Available: ${Object.keys(cfg.profiles).join(', ')}`)
  }
  return { name: target, profile }
}
