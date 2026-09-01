/**
 * Server entrypoint. Loads config from env, builds the facilitator, and
 * starts listening. `createServer()` is exported for programmatic use/tests.
 */
import { Express } from 'express';
import { createApp } from './server';
import { loadConfig, ServerConfig } from './config';
import { Logger } from './logger';
import { Facilitator } from './facilitator/facilitator';
import { MockFacilitator } from './facilitator/mock-facilitator';

export { createApp } from './server';
export * from './config';
export * from './logger';
export * from './x402';
export * from './facilitator/facilitator';
export * from './facilitator/mock-facilitator';
export * from './chat';
export * from './model-stub';

/**
 * Build the facilitator from environment-provided configuration.
 *
 * TODO(real-facilitator): when the real t54 client is implemented, return an
 * instance that talks to XRPL_FACILITATOR_URL on network XRPL_NETWORK. Until
 * then we use the in-memory MockFacilitator so the server runs locally with
 * zero external state. No mainnet values are hardcoded here.
 */
export function createFacilitator(config: ServerConfig): Facilitator {
  // XRPL_FACILITATOR_URL / XRPL_NETWORK are read into config and consumed by
  // the future real client; the mock is the local default until then.
  void config.facilitatorUrl;
  return new MockFacilitator();
}

export interface ServerHandle {
  app: Express;
  facilitator: Facilitator;
  config: ServerConfig;
  log: Logger;
}

/** Assemble the app plus its runtime bits (does not listen). */
export function createServer(
  config: ServerConfig = loadConfig(),
  log: Logger = new Logger(config.logLevel)
): ServerHandle {
  const facilitator = createFacilitator(config);
  const app = createApp({ facilitator, config, logger: log });
  return { app, facilitator, config, log };
}

/** Start the HTTP server. Resolves with the listening server handle. */
export function startServer(config: ServerConfig = loadConfig()) {
  const { app, log, config: cfg } = createServer(config);
  const server = app.listen(cfg.port, cfg.host, () => {
    log.info('server_listening', { host: cfg.host, port: cfg.port });
  });
  return server;
}

// Start only when run directly (not when imported by tests).
/* istanbul ignore next */
if (require.main === module) {
  startServer();
}