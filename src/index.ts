#!/usr/bin/env node
import { startServer } from './server.js'
import { logger } from './utils/logger.js'

startServer().catch(err => {
  logger.fatal({ err: err.message, stack: err.stack }, 'fatal startup error')
  process.exit(1)
})
