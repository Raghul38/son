/**
 * Express application assembly for the XRP-Pay Router server.
 *
 * Wires the x402 payment middleware in front of the POST /v1/chat handler so
 * every chat request is payment-gated. Facilitator and config are injected so
 * tests can pass a MockFacilitator and assert on the 402 flow deterministically.
 */
import express, { Express, NextFunction, Request, Response } from 'express';
import { Facilitator } from './facilitator/facilitator';
import { ServerConfig } from './config';
import { Logger } from './logger';
import { x402PaymentMiddleware } from './x402';
import { createChatHandler } from './chat';

export interface AppDeps {
  facilitator: Facilitator;
  config: ServerConfig;
  logger?: Logger;
  /**
   * Injectable fetch passed down to the LLM provider adapters. Tests use it to
   * drive provider responses (including the routing fallback chain) without
   * any network access; production leaves it undefined and the adapters use
   * Node's global fetch.
   */
  fetchImpl?: typeof fetch;
}

/** Assemble and return the Express app (does not listen). Tests use this. */
export function createApp(deps: AppDeps): Express {
  const log = deps.logger ?? new Logger(deps.config.logLevel);
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json());

  // Simple request log for every call that reaches the app.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    log.debug('request', { method: req.method, path: req.path });
    next();
  });

  // TODO(real-facilitator): exchange the mock for the t54 hosted XRPL
  // facilitator (XRPL_FACILITATOR_URL / XRPL_NETWORK from env). The
  // Facilitator interface is the seam; see createFacilitator() in index.ts.
  app.post(
    '/v1/chat',
    x402PaymentMiddleware(deps.facilitator, deps.config, log),
    createChatHandler(deps.config, log, deps.fetchImpl)
  );

  // 404 for unknown routes.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'NOT_FOUND' });
  });

  // Central error handler — never leak stack traces to clients.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('unhandled_error', { message: err.message });
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  return app;
}