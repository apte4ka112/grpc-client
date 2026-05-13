import { z } from 'zod'

export const ProfileSchema = z.object({
  host: z.string(),
  proto: z.object({ protoDir: z.string() }),
  headers: z.record(z.string()).default({}),
  cookies: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().default(10000),
  insecureSkipVerify: z.boolean().default(false)
})
export type Profile = z.infer<typeof ProfileSchema>

export const ConfigSchema = z.object({
  active: z.string(),
  profiles: z.record(ProfileSchema),
  debug: z.boolean().default(false),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info')
})
export type Config = z.infer<typeof ConfigSchema>

export const RuntimeOverridesSchema = z
  .object({
    host: z.string().optional(),
    headers: z.record(z.string()).optional(),
    cookies: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    proto: z.object({ protoDir: z.string() }).optional()
  })
  .partial()
export type RuntimeOverrides = z.infer<typeof RuntimeOverridesSchema>
