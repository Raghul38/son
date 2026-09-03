/**
 * Server configuration — everything comes from env vars.
 *
 * HARD CONSTRAINT: no hardcoded private keys, no hardcoded mainnet
 * addresses or network ids. All URLs/addresses/network ids are read
 * from the environment (see .env.example).
 */

export interface ServerConfig {
  /** Port to listen on. Default 8080 (not 3000 — that is the site's port). */
  port: number;
  /** Host to bind. Default 0.0.0.0 so the server is reachable outside loopback. */
  host: string;
  /**
   * t54 hosted XRPL facilitator base URL. No default — must be provided
   * via XRPL_FACILITATOR_URL when the real facilitator is wired in.
   */
  facilitatorUrl: string;
  /**
   * XRPL network id used in x402 payment requests, e.g. "xrpl:0" (mainnet)
   * or "xrpl:1" (testnet). Read from XRPL_NETWORK. Defaults to testnet so a
   * misconfigured server never silently targets mainnet.
   */
  network: string;
  /**
   * Receiver address (the address that collects payments). Read from
   * PAYMENT_RECEIVER. When empty, the server cannot build payment requests.
   */
  paymentReceiver: string;
  /**
   * Per-request payment reward. For XRP this is drops (1 XRP = 1_000_000
   * drops). For an issued currency like RLUSD this is the currency value
   * (e.g. "0.01"). Read from PAYMENT_REWARD_DROPS. Default 1 XRP.
   */
  rewardDrops: string;
  /**
   * Which payment facilitator to use (PAYMENT_FACILITATOR):
   *   - "mock"      -> MockFacilitator: zero-config local default, no network.
   *   - "quicknode" -> QuickNodeFacilitator: real on-ledger XRP/RLUSD
   *                    verification over XRPL JSON-RPC. Requires XRPL_RPC_URL.
   *   - "t54"       -> T54Facilitator: verify+settle via the hosted T54 x402
   *                    facilitator. Requires T54_FACILITATOR_URL.
   * Default "mock" keeps today's zero-config behavior unchanged.
   */
  paymentFacilitator: 'mock' | 'quicknode' | 't54';
  /**
   * Hosted T54 x402 facilitator base URL (T54_FACILITATOR_URL), e.g.
   * https://xrpl-facilitator-testnet.t54.ai. Required when
   * PAYMENT_FACILITATOR=t54. Empty default otherwise.
   */
  t54FacilitatorUrl: string;
  /**
   * Real on-ledger verification endpoint (XRPL_RPC_URL): an XRPL JSON-RPC
   * endpoint such as a QuickNode XRPL endpoint or the public testnet node
   * https://s.altnet.rippletest.net:51234. Used by the QuickNode
   * facilitator. When empty (the default) and PAYMENT_FACILITATOR=mock,
   * the zero-config MockFacilitator is used so local dev needs no network.
   */
  xrplRpcUrl: string;
  /**
   * Payment asset advertised in x402 challenges (PAYMENT_ASSET):
   * "XRP" (default) or an issued currency such as "RLUSD". RLUSD requires
   * RLUSD_ISSUER to be configured too.
   */
  paymentAsset: string;
  /**
   * Issuer of the RLUSD token (RLUSD_ISSUER). Only read when
   * PAYMENT_ASSET is RLUSD; unused for XRP payments.
   */
  rlusdIssuer: string;
  /** Public base URL of this server (used in logs/errors, optional). */
  publicUrl: string;
  /** Request logging level. Default "info". */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * DeepSeek API key (LLM_API_KEY). When empty, routed "deepseek" requests
   * fall back to the model stub so local dev needs zero configuration.
   */
  llmApiKey: string;
  /** DeepSeek (OpenAI-compatible) API base URL. Default: https://api.deepseek.com */
  llmBaseUrl: string;
  /** Hard deadline for one LLM provider call, in milliseconds. Default 30000. */
  llmTimeoutMs: number;
  /**
   * Which router-core strategy picks the model (ROUTING_STRATEGY):
   *   - "cheapest" (default) -> the original cheapest-capable routing.
   *   - "tiered"   -> classify the prompt first, then pick the cheapest model
   *                   that satisfies the tier's capability requirements.
   * Unknown values fall back to "cheapest" so a typo never changes billing
   * behavior silently.
   */
  routingStrategy: 'cheapest' | 'tiered';
  /**
   * Skip models whose provider this server cannot actually call
   * (ROUTING_SKIP_UNCONFIGURED_PROVIDERS). Off by default, which preserves
   * today's behavior: an unconfigured provider is routed to and answered by
   * the stub. On, a paid request is routed only to a provider with a working
   * adapter + credentials.
   */
  routingSkipUnconfiguredProviders: boolean;
  /**
   * How many models from the fallback chain may be tried for ONE request
   * (ROUTING_MAX_ATTEMPTS, default 2). Only retryable provider failures
   * (busy / timeout / provider error) advance to the next model.
   */
  routingMaxAttempts: number;
}

function env(name: string): string | undefined {
  return process.env[name];
}

function requireEnv(name: string, fallback?: string): string {
  const value = env(name);
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `Missing required environment variable ${name}. Set it in .env or the environment.`
    );
  }
  return value;
}

function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0 || n > 65535) return fallback;
  return n;
}

/** Parse a positive integer env value, falling back when absent/invalid. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n <= 0) return fallback;
  return n;
}

function parseLogLevel(value: string | undefined): ServerConfig['logLevel'] {
  switch (value) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return value;
    default:
      return 'info';
  }
}

/** Parse the payment facilitator selector; unknown values fall back to "mock". */
function parsePaymentFacilitator(value: string | undefined): ServerConfig['paymentFacilitator'] {
  switch (value) {
    case 'mock':
    case 'quicknode':
    case 't54':
      return value;
    default:
      return 'mock';
  }
}

/** Parse the routing strategy selector; unknown values fall back to "cheapest". */
function parseRoutingStrategy(value: string | undefined): ServerConfig['routingStrategy'] {
  switch (value) {
    case 'cheapest':
    case 'tiered':
      return value;
    default:
      return 'cheapest';
  }
}

/** Parse a boolean env value ("1"/"true"/"yes" are true); default false. */
function parseBool(value: string | undefined): boolean {
  switch ((value ?? '').toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
      return true;
    default:
      return false;
  }
}

/** Load configuration from process.env. Throws if a required var is missing. */
export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const config: ServerConfig = {
    port: parsePort(env('PORT'), 8080),
    host: env('HOST') ?? '0.0.0.0',
    facilitatorUrl: requireEnv('XRPL_FACILITATOR_URL', ''),
    network: requireEnv('XRPL_NETWORK', 'xrpl:1'),
    paymentReceiver: requireEnv('PAYMENT_RECEIVER', ''),
    rewardDrops: requireEnv('PAYMENT_REWARD_DROPS', '1000000'),
    paymentFacilitator: parsePaymentFacilitator(env('PAYMENT_FACILITATOR')),
    t54FacilitatorUrl: env('T54_FACILITATOR_URL') ?? '',
    xrplRpcUrl: env('XRPL_RPC_URL') ?? '',
    paymentAsset: requireEnv('PAYMENT_ASSET', 'XRP'),
    rlusdIssuer: env('RLUSD_ISSUER') ?? '',
    publicUrl: env('PUBLIC_URL') ?? '',
    logLevel: parseLogLevel(env('LOG_LEVEL')),
    llmApiKey: env('LLM_API_KEY') ?? '',
    llmBaseUrl: env('LLM_BASE_URL') ?? 'https://api.deepseek.com',
    llmTimeoutMs: parsePositiveInt(env('LLM_TIMEOUT_MS'), 30000),
    routingStrategy: parseRoutingStrategy(env('ROUTING_STRATEGY')),
    routingSkipUnconfiguredProviders: parseBool(env('ROUTING_SKIP_UNCONFIGURED_PROVIDERS')),
    routingMaxAttempts: parsePositiveInt(env('ROUTING_MAX_ATTEMPTS'), 2),
  };
  return { ...config, ...overrides };
}