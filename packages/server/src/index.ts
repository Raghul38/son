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
import { QuickNodeFacilitator } from './facilitator/quicknode-facilitator';

export { createApp } from './server';
export * from './config';
export * from './logger';
export * from './x402';
export * from './facilitator/facilitator';
export * from './facilitator/mock-facilitator';
export * from './facilitator/quicknode-facilitator';
export * from './chat';
export * from './model-stub';

/**
 * Build the facilitator from environment-provided configuration.
 *
 * Wire selection (keep it simple):
 *   - XRPL_RPC_URL is set   -> QuickNodeFacilitator: REAL on-ledger payment
 *     verification over XRPL JSON-RPC (QuickNode or any public node).
 *   - otherwise             -> MockFacilitator: zero-config local default,
 *     so the server runs and all existing tests pass with no network/funds.
 *
 * The real facilitator verifies in-process against the ledger (T54 "exact"
 * scheme) — no hosted facilitator service, no xrpl.js. Nothing mainnet is
 * hardcoded here; every URL/address/network id comes from the environment.
 */
export function createFacilitator(config: ServerConfig): Facilitator {
  if (config.xrplRpcUrl !== '') {
    return new QuickNodeFacilitator({
      network: config.network,
      receiver: config.paymentReceiver,
      rewardDrops: config.rewardDrops,
      rpcUrl: config.xrplRpcUrl,
      asset: config.paymentAsset,
      issuer: config.paymentAsset === 'XRP' ? undefined : config.rlusdIssuer,
    });
  }
  // XRPL_FACILITATOR_URL is still read into config for backwards compatibility
  // with earlier docs; the current design verifies via XRPL_RPC_URL instead.
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