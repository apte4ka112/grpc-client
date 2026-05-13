import { status as GrpcStatus } from '@grpc/grpc-js'

export interface FormattedError {
  error: true
  code: number
  status: string
  message: string
  trailers?: Record<string, string>
  stack?: string
}

export function formatError(err: unknown): FormattedError {
  if (err instanceof Error) {
    const e = err as Error & { code?: number; details?: string; trailers?: Record<string, string> }
    const code = typeof e.code === 'number' ? e.code : GrpcStatus.UNKNOWN
    return {
      error: true,
      code,
      status: GrpcStatus[code] ?? `CODE_${code}`,
      message: e.details ?? e.message,
      trailers: e.trailers,
      stack: e.stack
    }
  }
  return { error: true, code: GrpcStatus.UNKNOWN, status: GrpcStatus[GrpcStatus.UNKNOWN], message: String(err) }
}
