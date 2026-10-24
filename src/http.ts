import { createHash, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type RequestHandler } from 'express';
import type { AppContext } from './context.js';
import { createMcpServer } from './mcp/server.js';

/** Constant-time bearer token check (hashing first makes the compared buffers equal length). */
export function bearerAuth(token: string): RequestHandler {
  const expected = createHash('sha256').update(token).digest();
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!given || !timingSafeEqual(createHash('sha256').update(given).digest(), expected)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    next();
  };
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};

/** Serves GET /health and, when MCP_AUTH_TOKEN is set, the MCP endpoint at POST /mcp. */
export function startHttpServer(ctx: AppContext): Server {
  const { config, client } = ctx;
  const app = express();
  app.disable('x-powered-by');

  // Registered before any Host validation so container health checks against 127.0.0.1 always work.
  app.get('/health', (_req, res) => {
    const discordReady = client.isReady();
    res.status(discordReady ? 200 : 503).json({ status: discordReady ? 'ok' : 'starting', discord: discordReady });
  });

  if (config.MCP_AUTH_TOKEN) {
    // Host allow-listing guards against DNS rebinding; the bearer token is the real access control.
    const guards = [...(config.MCP_ALLOWED_HOSTS ? [hostHeaderValidation(config.MCP_ALLOWED_HOSTS)] : []), bearerAuth(config.MCP_AUTH_TOKEN)];
    // Stateless Streamable HTTP: a fresh server + transport per request, so no session bookkeeping.
    app.post('/mcp', ...guards, express.json({ limit: '1mb' }), async (req, res) => {
      const server = createMcpServer(ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error('[mcp] request failed:', err);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
        }
      }
    });
    app.get('/mcp', ...guards, methodNotAllowed);
    app.delete('/mcp', ...guards, methodNotAllowed);
  } else {
    console.warn('[mcp] MCP_AUTH_TOKEN is not set: the MCP endpoint is disabled.');
  }

  return app.listen(config.HTTP_PORT, config.HTTP_HOST, () => {
    console.log(`[http] listening on ${config.HTTP_HOST}:${config.HTTP_PORT}${config.MCP_AUTH_TOKEN ? ' (MCP at /mcp)' : ''}`);
  });
}
