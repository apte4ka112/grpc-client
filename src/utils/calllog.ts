import fs from 'node:fs'
import path from 'node:path'
import { logger } from './logger.js'

const FILE_NAME = 'calls.jsonl'
const MAX_FIELD_BYTES = 16 * 1024
const ensuredDirs = new Set<string>()

export interface CallLogEntry {
  ts: string
  profile: string
  target: string
  host: string
  durationMs?: number
  status?: { code: number; name: string }
  error?: { code: number; status: string; message: string }
  dryRun?: boolean
  request?: unknown
}

export function appendCallLog(dataDir: string, entry: CallLogEntry): void {
  try {
    if (!ensuredDirs.has(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
      ensuredDirs.add(dataDir)
    }
    const safe = { ...entry, request: truncate(entry.request) }
    fs.appendFileSync(path.join(dataDir, FILE_NAME), JSON.stringify(safe) + '\n')
  } catch (err) {
    logger.warn({ err: (err as Error).message, dataDir }, 'failed to write calls.jsonl')
  }
}

function truncate(value: unknown): unknown {
  if (value === undefined) return undefined
  const s = JSON.stringify(value)
  if (s === undefined) return undefined
  if (s.length <= MAX_FIELD_BYTES) return value
  return { _truncated: true, bytes: s.length, preview: s.slice(0, MAX_FIELD_BYTES) }
}
