import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadConfig } from './config/loader.js'
import { setLogLevel, logger } from './utils/logger.js'
import { buildTools } from './tools/index.js'
import { closeAllClients } from './grpc.js'

export async function startServer() {
  const cfg = loadConfig()
  const initial = cfg.read()
  setLogLevel(process.env.GRPC_CLIENT_LOG_LEVEL ?? initial.logLevel)
  logger.info(
    { source: cfg.source, filePath: cfg.filePath, dataDir: cfg.dataDir, active: initial.active, profiles: Object.keys(initial.profiles) },
    'config loaded'
  )

  const tools = buildTools(cfg)
  const toolMap = new Map(tools.map(t => [t.name, t]))

  const server = new Server(
    { name: 'grpc-client', version: '2.0.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
  }))

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const { name, arguments: args = {} } = req.params
    const tool = toolMap.get(name)
    if (!tool) {
      return { content: [{ type: 'text', text: `ERROR: Unknown tool ${name}` }], isError: true }
    }
    try {
      const result = await tool.handler(args)
      const isError = !!(result && typeof result === 'object' && (result as any).error === true)
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError
      }
    } catch (err) {
      logger.error({ tool: name, err: (err as Error).message, stack: (err as Error).stack }, 'tool handler threw')
      return {
        content: [{ type: 'text', text: `ERROR: ${(err as Error).message}` }],
        isError: true
      }
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  logger.info('mcp server connected (stdio)')

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down')
    closeAllClients()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
