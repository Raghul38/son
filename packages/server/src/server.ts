/**
 * Express application assembly for the XRP-Pay Router server.
 *
 * Wires the x402 payment middleware in front of the POST /v1/chat handler so
 * every chat request is payment-gated. Facilitator and config are injected so
 * tests can pass a MockFacilitator and assert on the 402 flow deterministically.
 */
import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import { Facilitator } from './facilitator/facilitator';
import { ServerConfig } from './config';
import { Logger } from './logger';
import { x402PaymentMiddleware } from './x402';
import { createChatHandler } from './chat';
import { ActivityLog, activityRecorder } from './activity';
import { createConsoleApi } from './api';

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
  /**
   * Request ledger the console reads. Injectable so a test can pre-seed it or
   * assert on it directly; one is created per app otherwise.
   */
  ledger?: ActivityLog;
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

  const ledger = deps.ledger ?? new ActivityLog(deps.config.activityRetention);

  // TODO(real-facilitator): exchange the mock for the t54 hosted XRPL
  // facilitator (XRPL_FACILITATOR_URL / XRPL_NETWORK from env). The
  // Facilitator interface is the seam; see createFacilitator() in index.ts.
  //
  // The recorder runs FIRST so a 402 is recorded too — "payment required" and
  // "payment rejected" are results the console has to show. It only observes.
  app.post(
    '/v1/chat',
    activityRecorder(ledger, deps.config),
    x402PaymentMiddleware(deps.facilitator, deps.config, log),
    createChatHandler(deps.config, log, deps.fetchImpl)
  );

  // Read-only console API (catalog, public config, request ledger).
  app.use(createConsoleApi({ config: deps.config, ledger, facilitatorName: deps.facilitator.name }));

  // Optionally serve the built console (packages/web/dist) from this same
  // origin, so a deployment is one process and the browser needs no CORS.
  // Unset by default: `npm run dev` uses Vite's dev server and its proxy.
  if (deps.config.webDist !== '') {
    const root = path.resolve(deps.config.webDist);
    app.use(express.static(root));
    // SPA fallback for client-side routes only. API paths and every non-GET
    // request fall through to the 404 below, so a typo in an endpoint still
    // reads as a 404 instead of silently returning HTML.
    app.get(/^(?!\/v1\/).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(root, 'index.html'));
    });
  }

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