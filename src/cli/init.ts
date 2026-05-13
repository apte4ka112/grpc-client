import fs from 'node:fs'
import path from 'node:path'

const DIR_NAME = '.grpc-client'
const FILE_NAME = 'config.json'
const PACKAGE_REF = 'github:apte4ka112/grpc-client'

export interface InitOptions {
  cwd: string
  packageRef?: string
}

export interface InitResult {
  configPath: string
  mcpPath: string
  gitignorePath: string | null
  protoDir: string | null
  createdConfig: boolean
  updatedMcp: boolean
  appendedGitignore: boolean
}

export function runInit(opts: InitOptions): InitResult {
  const cwd = path.resolve(opts.cwd)
  const packageRef = opts.packageRef ?? PACKAGE_REF
  const dataDir = path.join(cwd, DIR_NAME)
  const configPath = path.join(dataDir, FILE_NAME)
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

  const mcp: { mcpServers?: Record<string, unknown> } = fs.existsSync(mcpPath)
    ? JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
    : {}
  mcp.mcpServers = mcp.mcpServers ?? {}
  mcp.mcpServers['grpc-client'] = { command: 'npx', args: [packageRef] }
  fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n')

  const giPath = path.join(cwd, '.gitignore')
  let appendedGitignore = false
  let gitignorePath: string | null = null
  if (fs.existsSync(giPath)) {
    gitignorePath = giPath
    const text = fs.readFileSync(giPath, 'utf8')
    const lines = text.split('\n').map(l => l.trim())
    if (!lines.includes(`${DIR_NAME}/`) && !lines.includes(DIR_NAME)) {
      const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
      fs.appendFileSync(giPath, `${sep}\n# grpc-client MCP local config + call log\n${DIR_NAME}/\n`)
      appendedGitignore = true
    }
  }

  return {
    configPath,
    mcpPath,
    gitignorePath,
    protoDir,
    createdConfig,
    updatedMcp: true,
    appendedGitignore
  }
}

function findProtoDir(cwd: string): string | null {
  const nm = path.join(cwd, 'node_modules')
  if (!fs.existsSync(nm)) return null
  const candidates: string[] = []
  scan(nm, candidates, 4)
  candidates.sort((a, b) => {
    const ap = /api[-_]?client\/proto$/.test(a) ? 0 : 1
    const bp = /api[-_]?client\/proto$/.test(b) ? 0 : 1
    if (ap !== bp) return ap - bp
    return a.length - b.length
  })
  return candidates[0] ?? null
}

function scan(dir: string, out: string[], depthLeft: number): void {
  if (depthLeft <= 0) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.name === 'proto') {
      try {
        if (fs.readdirSync(p).some(f => f.endsWith('.proto'))) {
          out.push(p)
          continue
        }
      } catch {
        /* ignore */
      }
    }
    scan(p, out, depthLeft - 1)
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
  lines.push(`  .mcp.json: ${r.mcpPath} (grpc-client server registered)`)
  if (r.gitignorePath) {
    lines.push(`  .gitignore: ${r.gitignorePath}${r.appendedGitignore ? ' (added .grpc-client/)' : ' (already had .grpc-client/)'}`)
  }
  lines.push(`  protoDir:  ${r.protoDir ?? 'NOT DETECTED — edit config.json before first call'}`)
  lines.push('')
  lines.push('Next: open the config and fill in host/headers/cookies, then restart Claude Code.')
  lines.push('To import a curl request as a profile, paste it into Claude and call the `grpc_import_curl` tool.')
  return lines.join('\n')
}
