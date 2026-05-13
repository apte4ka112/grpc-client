const GRPC_STATUS_NAMES: Record<number, string> = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED'
}

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
    const code = typeof e.code === 'number' ? e.code : 2
    return {
      error: true,
      code,
      status: GRPC_STATUS_NAMES[code] ?? `CODE_${code}`,
      message: e.details ?? e.message,
      trailers: e.trailers,
      stack: e.stack
    }
  }
  return { error: true, code: 2, status: 'UNKNOWN', message: String(err) }
}
