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
  /** Per-request payment reward in XRP drops. Default 1 XRP. */
  rewardDrops: string;
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

/** Load configuration from process.env. Throws if a required var is missing. */
export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const config: ServerConfig = {
    port: parsePort(env('PORT'), 8080),
    host: env('HOST') ?? '0.0.0.0',
    facilitatorUrl: requireEnv('XRPL_FACILITATOR_URL', ''),
    network: requireEnv('XRPL_NETWORK', 'xrpl:1'),
    paymentReceiver: requireEnv('PAYMENT_RECEIVER', ''),
    rewardDrops: requireEnv('PAYMENT_REWARD_DROPS', '1000000'),
    publicUrl: env('PUBLIC_URL') ?? '',
    logLevel: parseLogLevel(env('LOG_LEVEL')),
    llmApiKey: env('LLM_API_KEY') ?? '',
    llmBaseUrl: env('LLM_BASE_URL') ?? 'https://api.deepseek.com',
    llmTimeoutMs: parsePositiveInt(env('LLM_TIMEOUT_MS'), 30000),
  };
  return { ...config, ...overrides };
}