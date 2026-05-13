import fs from 'node:fs'
import path from 'node:path'
import { ConfigSchema, type Config, type Profile } from './schema.js'

const DEFAULT_FILE = 'profiles.json'

function resolveConfigPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit)
  const env = process.env.GRPC_CLIENT_CONFIG
  if (env) return path.resolve(env)
  return path.resolve(process.cwd(), DEFAULT_FILE)
}

export interface LoadedConfig {
  filePath: string
  data: Config
}

export function loadConfig(filePath?: string): LoadedConfig {
  const resolved = resolveConfigPath(filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found: ${resolved}. Set GRPC_CLIENT_CONFIG or place profiles.json in cwd.`)
  }
  const data = ConfigSchema.parse(JSON.parse(fs.readFileSync(resolved, 'utf8')))
  if (!data.profiles[data.active]) {
    throw new Error(`Active profile "${data.active}" missing from profiles.`)
  }
  return { filePath: resolved, data }
}

export function getProfile(cfg: LoadedConfig, name?: string): { name: string; profile: Profile } {
  const target = name ?? cfg.data.active
  const profile = cfg.data.profiles[target]
  if (!profile) {
    throw new Error(`Profile "${target}" not found. Available: ${Object.keys(cfg.data.profiles).join(', ')}`)
  }
  return { name: target, profile }
}
