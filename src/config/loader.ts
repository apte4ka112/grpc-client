import fs from 'node:fs'
import path from 'node:path'
import { ConfigSchema, type Config, type Profile } from './schema.js'

const DIR_NAME = '.grpc-client'
const FILE_NAME = 'config.json'

function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  const env = process.env.GRPC_CLIENT_CONFIG
  if (env) return path.resolve(env)
  return path.resolve(process.cwd(), DIR_NAME, FILE_NAME)
}

export interface LoadedConfig {
  filePath: string
  dataDir: string
  read(): Config
}

export function loadConfig(filePath?: string): LoadedConfig {
  const resolved = resolveConfigPath(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Config not found: ${resolved}. ` +
        `Create ./${DIR_NAME}/${FILE_NAME} in the host project, ` +
        `or set GRPC_CLIENT_CONFIG=/abs/path.`
    )
  }
  const configDir = path.dirname(resolved)
  const dataDir = path.basename(configDir) === DIR_NAME
    ? configDir
    : path.join(configDir, DIR_NAME)

  const read = (): Config => {
    const parsed = ConfigSchema.parse(JSON.parse(fs.readFileSync(resolved, 'utf8')))
    if (!parsed.profiles[parsed.active]) {
      throw new Error(`Active profile "${parsed.active}" missing from profiles.`)
    }
    for (const [name, p] of Object.entries(parsed.profiles)) {
      parsed.profiles[name] = { ...p, proto: { protoDir: path.resolve(configDir, p.proto.protoDir) } }
    }
    return parsed
  }
  return { filePath: resolved, dataDir, read }
}

export function getProfile(cfg: Config, name?: string): { name: string; profile: Profile } {
  const target = name ?? cfg.active
  const profile = cfg.profiles[target]
  if (!profile) {
    throw new Error(`Profile "${target}" not found. Available: ${Object.keys(cfg.profiles).join(', ')}`)
  }
  return { name: target, profile }
}
