import pino from 'pino'

// MCP uses stdout for protocol — all logs go to stderr.
export const logger = pino(
  { level: 'info', base: { name: 'grpc-client' }, timestamp: pino.stdTimeFunctions.isoTime },
  pino.destination({ fd: 2, sync: false })
)

export function setLogLevel(next: string) {
  logger.level = next
}
