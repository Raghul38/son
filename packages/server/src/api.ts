/**
 * Read-only JSON API for the Sonpay console (packages/web).
 *
 * Everything here reports on the gateway rather than changing it: the model
 * catalog, the public half of the server configuration, and the in-memory
 * request ledger. `POST /v1/chat` remains the only endpoint that costs money
 * and the only one behind the x402 middleware.
 *
 * Nothing secret is served. `GET /v1/config` deliberately exposes the receiver
 * address, network, asset and amount — every one of them is already inside the
 * 402 challenge any unpaid caller receives — and deliberately exposes no key,
 * token or URL that carries one.
 */
import { Request, RequestHandler, Response, Router } from 'express';
import { ActivityLog, toPaymentRecords } from './activity';
import { buildCatalog, buildProviders } from './catalog';
import { ServerConfig } from './config';

/** How many rows a list endpoint returns when the caller does not say. */
const DEFAULT_LIMIT = 100;

function parseLimit(value: unknown, max: number): number {
  if (typeof value !== 'string' || value === '') return Math.min(DEFAULT_LIMIT, max);
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return Math.min(DEFAULT_LIMIT, max);
  return Math.min(n, max);
}

/** The public description of this gateway — what a client needs to pay it. */
export function publicConfig(config: ServerConfig, facilitatorName: string) {
  return {
    endpoints: { chat: '/v1/chat' },
    payment: {
      scheme: 'x402',
      network: config.network,
      asset: config.paymentAsset,
      /** XRP drops, or the IOU value for an issued currency. */
      amount: config.rewardDrops,
      receiver: config.paymentReceiver,
      ...(config.paymentAsset !== 'XRP' && { issuer: config.rlusdIssuer }),
      facilitator: facilitatorName,
      /** How the payer binds an on-ledger payment to a challenge. */
      binding: 'memo',
      header: 'X-PAYMENT',
    },
    routing: {
      strategy: config.routingStrategy,
      maxAttempts: config.routingMaxAttempts,
      skipUnconfiguredProviders: config.routingSkipUnconfiguredProviders,
    },
    pricing: { currency: 'USD', markupBps: config.platformMarkupBps },
    metering: {
      // Configured, not "reachable" — the server does not probe OpenMeter to
      // answer a page load.
      enabled: config.openmeterUrl !== '' && config.openmeterApiKey !== '',
      source: config.openmeterSource,
    },
    apiKeys: {
      supported: false,
      reason:
        'This gateway authenticates with x402 payments only. There is no key to issue, ' +
        'and no key can replace a payment.',
    },
  };
}

export interface ConsoleApiDeps {
  config: ServerConfig;
  ledger: ActivityLog;
  /** Name of the facilitator this server verifies payments with. */
  facilitatorName: string;
}

/** Mountable router with every console endpoint. */
export function createConsoleApi(deps: ConsoleApiDeps): Router {
  const { config, ledger } = deps;
  const router = Router();

  const json =
    (handler: (req: Request) => unknown): RequestHandler =>
    (req: Request, res: Response) => {
      res.status(200).json(handler(req));
    };

  router.get('/healthz', json(() => ({ status: 'ok', service: 'sonpay-gateway' })));

  router.get('/v1/config', json(() => publicConfig(config, deps.facilitatorName)));

  router.get(
    '/v1/models',
    json(() => ({
      data: buildCatalog(config),
      providers: buildProviders(config),
    }))
  );

  router.get(
    '/v1/activity',
    json((req) => {
      const limit = parseLimit(req.query.limit, 500);
      return {
        data: ledger.list(limit),
        summary: ledger.summary(),
        // The pages show this verbatim: a dashboard that quietly forgets is
        // worse than one that says it forgets.
        retention: { persistence: 'memory', retained: ledger.size },
      };
    })
  );

  router.get(
    '/v1/payments',
    json((req) => ({
      data: toPaymentRecords(ledger.list(parseLimit(req.query.limit, 500))),
      retention: { persistence: 'memory', retained: ledger.size },
    }))
  );

  // API keys: answered honestly rather than faked. x402 users need no key, and
  // this server has no key store, so there is nothing to create or revoke.
  router.get(
    '/v1/keys',
    json(() => ({
      supported: false,
      data: [],
      reason: publicConfig(config, deps.facilitatorName).apiKeys.reason,
    }))
  );
  const notSupported: RequestHandler = (_req: Request, res: Response) => {
    res.status(501).json({
      error: 'API_KEYS_NOT_SUPPORTED',
      message:
        'This gateway issues no API keys: access is granted by a verified x402 payment. ' +
        'Nothing was created, and nothing was revoked.',
    });
  };
  router.post('/v1/keys', notSupported);
  router.delete('/v1/keys/:id', notSupported);

  return router;
}
