import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { type RequestHandler } from 'express';
import type { AppContext } from './context.js';
import { LOGO_PATH, SS_EXAMPLE_PATH, SS_RANK_EXAMPLE_PATH } from './discord/identity.js';
import { createMcpServer } from './mcp/server.js';
import { adminRouter } from './web/admin/routes.js';
import { buildStatus, renderStatusPage } from './web/status.js';

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

/** Serves the status page (/, /status.json, /logo.png), /health and, when MCP_AUTH_TOKEN is set, POST /mcp. */
export function startHttpServer(ctx: AppContext): Server {
  const { config, client } = ctx;
  const app = express();
  app.disable('x-powered-by');

  // Registered before any Host validation so container health checks against 127.0.0.1 always work.
  app.get('/health', (_req, res) => {
    const discordReady = client.isReady();
    res.status(discordReady ? 200 : 503).json({ status: discordReady ? 'ok' : 'starting', discord: discordReady });
  });

  // Admin panel: Discord login, whitelisted admins only (off until DISCORD_CLIENT_SECRET and PUBLIC_URL are set).
  app.use('/admin', adminRouter(ctx));

  // Public status page. Page and JSON show aggregate clan data only (no member names or IDs).
  app.get('/', async (_req, res, next) => {
    try {
      const nonce = randomBytes(16).toString('base64');
      res
        .set({
          'Content-Security-Policy': `default-src 'none'; img-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        .type('html')
        .send(renderStatusPage(await buildStatus(ctx), nonce));
    } catch (err) {
      next(err);
    }
  });
  app.get('/status.json', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store').json(await buildStatus(ctx));
    } catch (err) {
      next(err);
    }
  });
  // The example profile card shown in the screenshot-roles sticky message (Discord fetches it from here).
  app.get('/ss-example.png', (_req, res) => {
    res.sendFile(SS_EXAMPLE_PATH, { maxAge: '1d' }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });
  app.get('/ss-example-rank.png', (_req, res) => {
    res.sendFile(SS_RANK_EXAMPLE_PATH, { maxAge: '1d' }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
  });
  app.get('/logo.png', (_req, res) => {
    res.sendFile(LOGO_PATH, { maxAge: '1d' }, (err) => {
      if (err && !res.headersSent) res.sendStatus(404);
    });
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

  // Express 5 reports listen failures (e.g. port already in use) through this callback, not by throwing.
  return app.listen(config.HTTP_PORT, config.HTTP_HOST, (err) => {
    if (err) {
      console.error(`[http] could not listen on ${config.HTTP_HOST}:${config.HTTP_PORT}:`, err);
      process.exit(1);
    }
    console.log(`[http] listening on ${config.HTTP_HOST}:${config.HTTP_PORT}${config.MCP_AUTH_TOKEN ? ' (MCP at /mcp)' : ''}`);
  });
}
