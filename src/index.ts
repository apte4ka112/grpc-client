#!/usr/bin/env node
import { startServer } from './server.js'
import { formatReport, runInit } from './cli/init.js'
import { logger } from './utils/logger.js'

const args = process.argv.slice(2)

if (args[0] === 'init') {
  try {
    const report = runInit({ cwd: process.cwd() })
    process.stdout.write(formatReport(report) + '\n')
    process.exit(0)
  } catch (err) {
    process.stderr.write(`init failed: ${(err as Error).message}\n`)
    process.exit(1)
  }
} else {
  startServer().catch(err => {
    logger.fatal({ err: err.message, stack: err.stack }, 'fatal startup error')
    process.exit(1)
  })
}
