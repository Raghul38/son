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
import { T54Facilitator } from './facilitator/t54-facilitator';

export { createApp } from './server';
export * from './config';
export * from './logger';
export * from './x402';
export * from './facilitator/facilitator';
export * from './facilitator/mock-facilitator';
export * from './facilitator/quicknode-facilitator';
export * from './facilitator/t54-facilitator';
export * from './chat';
export * from './model-stub';
export * from './activity';
export * from './api';
export * from './catalog';

/**
 * Build the facilitator from environment-provided configuration.
 *
 * Wire selection (keep it simple):
 *   - PAYMENT_FACILITATOR=t54      -> T54Facilitator: verify+settle via the
 *     hosted T54 x402 facilitator (requires T54_FACILITATOR_URL).
 *   - PAYMENT_FACILITATOR=quicknode or (default fallback) XRPL_RPC_URL set
 *     -> QuickNodeFacilitator: REAL on-ledger payment verification over XRPL
 *     JSON-RPC (QuickNode or any public node).
 *   - otherwise (default PAYMENT_FACILITATOR=mock)
 *     -> MockFacilitator: zero-config local default, so the server runs and
 *     all existing tests pass with no network/funds.
 *
 * Nothing mainnet is hardcoded here; every URL/address/network id comes from
 * the environment. Payment authorization always happens BEFORE any provider
 * execution; facilitators only verify/settle — the server never signs for a
 * payer.
 */
export function createFacilitator(config: ServerConfig): Facilitator {
  const selection: string = config.paymentFacilitator ?? 'mock';

  if (selection === 't54') {
    // T54 is opt-in and needs the hosted facilitator URL — fail fast at
    // startup with a clear message instead of failing every request later.
    if (config.t54FacilitatorUrl === '') {
      throw new Error(
        'PAYMENT_FACILITATOR=t54 requires T54_FACILITATOR_URL to be set ' +
          '(e.g. https://xrpl-facilitator-testnet.t54.ai).'
      );
    }
    return new T54Facilitator({
      baseUrl: config.t54FacilitatorUrl,
      network: config.network,
      receiver: config.paymentReceiver,
      rewardDrops: config.rewardDrops,
      asset: config.paymentAsset,
      issuer: config.paymentAsset === 'XRP' ? undefined : config.rlusdIssuer,
    });
  }

  if (selection === 'quicknode') {
    if (config.xrplRpcUrl === '') {
      throw new Error(
        'PAYMENT_FACILITATOR=quicknode requires XRPL_RPC_URL to be set ' +
          '(a QuickNode XRPL endpoint or a public testnet node).'
      );
    }
    return new QuickNodeFacilitator({
      network: config.network,
      receiver: config.paymentReceiver,
      rewardDrops: config.rewardDrops,
      rpcUrl: config.xrplRpcUrl,
      asset: config.paymentAsset,
      issuer: config.paymentAsset === 'XRP' ? undefined : config.rlusdIssuer,
    });
  }

  // "mock" is the DEFAULT selector and means "current zero-config behavior":
  // legacy auto-selection — if XRPL_RPC_URL is set we use the real in-process
  // verifier (backward compatible with earlier docs/tests); otherwise the
  // zero-config MockFacilitator.
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