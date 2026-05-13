export function parseCookieHeader(raw: string, into: Record<string, string> = {}): Record<string, string> {
  if (!raw) return into
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const k = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (k) into[k] = v
  }
  return into
}

export function formatCookieHeader(cookies: Record<string, string>): string {
  if (!cookies) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(cookies)) {
    if (!k || v == null || v === '') continue
    parts.push(`${k}=${v}`)
  }
  return parts.join('; ')
}
