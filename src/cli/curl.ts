export interface ParsedCurl {
  url: string
  host: string
  headers: Record<string, string>
  cookies: Record<string, string>
}

const VALUE_FLAGS = new Set([
  '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-A', '--user-agent', '-e', '--referer', '-u', '--user', '-o', '--output',
  '-F', '--form', '--max-time', '--connect-timeout', '--retry', '--resolve'
])

export function parseCurl(cmd: string): ParsedCurl {
  const tokens = tokenize(cmd)
  if (tokens[0] !== 'curl') throw new Error('input does not start with `curl`')

  let url = ''
  const headers: Record<string, string> = {}
  const cookies: Record<string, string> = {}

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-H' || t === '--header') {
      addHeader(tokens[++i] ?? '', headers, cookies)
    } else if (t === '-b' || t === '--cookie') {
      mergeCookies(tokens[++i] ?? '', cookies)
    } else if (VALUE_FLAGS.has(t)) {
      i++
    } else if (t.startsWith('--') && t.includes('=')) {
      // long flag with inline value — skip
    } else if (!t.startsWith('-') && !url) {
      url = t
    }
  }

  if (!url) throw new Error('no URL found in curl command')

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`invalid URL in curl: ${url}`)
  }
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
  const host = `${parsed.hostname}:${port}`
  return { url, host, headers, cookies }
}

function addHeader(raw: string, headers: Record<string, string>, cookies: Record<string, string>): void {
  const idx = raw.indexOf(':')
  if (idx < 0) return
  const name = raw.slice(0, idx).trim()
  const value = raw.slice(idx + 1).trim()
  if (!name) return
  if (name.toLowerCase() === 'cookie') {
    mergeCookies(value, cookies)
  } else {
    headers[name] = value
  }
}

function mergeCookies(raw: string, cookies: Record<string, string>): void {
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) cookies[k] = v
  }
}

function tokenize(input: string): string[] {
  const s = input.replace(/\\\r?\n/g, ' ').trim()
  const tokens: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  let escape = false

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (escape) {
      buf += ch
      escape = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escape = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '$' && s[i + 1] === "'") {
      // bash $'...' literal — treat as plain single-quoted
      quote = "'"
      i++
      continue
    }
    if (/\s/.test(ch)) {
      if (buf) {
        tokens.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf) tokens.push(buf)
  return tokens
}
