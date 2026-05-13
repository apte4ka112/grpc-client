import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_FILE, DIR_NAME, PACKAGE_REF } from '../config/paths.js'

const PREFERRED_PROTO_RE = /api[-_]?client\/proto$/

export interface InitOptions {
  cwd: string
  packageRef?: string
}

export interface InitResult {
  configPath: string
  mcpPath: string
  gitignore: { path: string; appended: boolean } | null
  protoDir: string | null
  createdConfig: boolean
  mcpChanged: boolean
}

export function runInit(opts: InitOptions): InitResult {
  const cwd = path.resolve(opts.cwd)
  const packageRef = opts.packageRef ?? PACKAGE_REF
  const dataDir = path.join(cwd, DIR_NAME)
  const configPath = path.join(dataDir, CONFIG_FILE)
  const mcpPath = path.join(cwd, '.mcp.json')

  const protoDir = findProtoDir(cwd)

  fs.mkdirSync(dataDir, { recursive: true })

  let createdConfig = false
  if (!fs.existsSync(configPath)) {
    const protoRel = protoDir
      ? toRelative(dataDir, protoDir)
      : '../node_modules/your-api/proto'
    const config = {
      active: 'dev',
      logLevel: 'info',
      profiles: {
        dev: {
          host: 'grpc.example.com:443',
          proto: { protoDir: protoRel },
          headers: {},
          cookies: {},
          timeoutMs: 30000
        }
      }
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    createdConfig = true
  }

  const desiredMcpEntry = { command: 'npx', args: [packageRef] }
  const mcp: { mcpServers?: Record<string, unknown> } = fs.existsSync(mcpPath)
    ? JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    : {}
  mcp.mcpServers = mcp.mcpServers ?? {}
  const mcpChanged =
    JSON.stringify(mcp.mcpServers['grpc-client']) !== JSON.stringify(desiredMcpEntry)
  if (mcpChanged) {
    mcp.mcpServers['grpc-client'] = desiredMcpEntry
    fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')
  }

  const giPath = path.join(cwd, '.gitignore')
  let gitignore: InitResult['gitignore'] = null
  if (fs.existsSync(giPath)) {
    const text = fs.readFileSync(giPath, 'utf8')
    const lines = text.split('\n').map(l => l.trim())
    const has = lines.includes(`${DIR_NAME}/`) || lines.includes(DIR_NAME)
    if (!has) {
      const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
      fs.appendFileSync(giPath, `${sep}\n# grpc-client MCP local config + call log\n${DIR_NAME}/\n`)
      gitignore = { path: giPath, appended: true }
    } else {
      gitignore = { path: giPath, appended: false }
    }
  }

  return { configPath, mcpPath, gitignore, protoDir, createdConfig, mcpChanged }
}

function findProtoDir(cwd: string): string | null {
  const nm = path.join(cwd, 'node_modules')
  if (!fs.existsSync(nm)) return null
  const found: { path: string; preferred: boolean }[] = []
  scan(nm, found, 4)
  found.sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.path.length - b.path.length)
  return found[0]?.path ?? null
}

function scan(dir: string, out: { path: string; preferred: boolean }[], depthLeft: number): boolean {
  if (depthLeft <= 0) return false
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.name === 'proto' && containsProtoFiles(p)) {
      const preferred = PREFERRED_PROTO_RE.test(p)
      out.push({ path: p, preferred })
      if (preferred) return true
      continue
    }
    if (scan(p, out, depthLeft - 1)) return true
  }
  return false
}

function containsProtoFiles(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some(f => f.endsWith('.proto'))
  } catch {
    return false
  }
}

function toRelative(from: string, to: string): string {
  const rel = path.relative(from, to)
  return rel.startsWith('.') || path.isAbsolute(rel) ? rel : `./${rel}`
}

export function formatReport(r: InitResult): string {
  const lines: string[] = []
  lines.push('grpc-client initialized.')
  lines.push(`  config:    ${r.configPath}${r.createdConfig ? '' : ' (kept existing)'}`)
  lines.push(`  .mcp.json: ${r.mcpPath}${r.mcpChanged ? ' (grpc-client server registered)' : ' (already up to date)'}`)
  if (r.gitignore) {
    lines.push(`  .gitignore: ${r.gitignore.path}${r.gitignore.appended ? ' (added .grpc-client/)' : ' (already had .grpc-client/)'}`)
  }
  lines.push(`  protoDir:  ${r.protoDir ?? 'NOT DETECTED — edit config.json before first call'}`)
  lines.push('')
  lines.push('Next: open the config and fill in host/headers/cookies, then restart Claude Code.')
  lines.push('After restart speak naturally: paste a curl in chat to refresh session, or say "дёрни GetCart" / "посмотри данные на dev по GetX" to call an RPC.')
  return lines.join('\n')
}
