/**
 * The gateway's API, as the console sees it.
 *
 * These types mirror the server's own (`packages/server/src/{api,catalog,
 * activity}.ts`) rather than a copy of them, because the console is deployed
 * as static files and must not import server code. Every field here is one the
 * server actually sends: when a rate, a payer or a price is absent from the
 * response it stays `undefined` here and the pages say "unknown" — nothing on
 * these pages is invented client-side.
 */

/** Base URL of the gateway. Same origin by default; the dev server proxies. */
const BASE = import.meta.env.VITE_API_BASE ?? '';

export type Capability = string;

export interface FreeTier {
  name: string;
  limit: string;
  active: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  capabilities: Capability[];
  inputCostPer1MTokens?: number;
  outputCostPer1MTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  availability: 'live' | 'stub';
  availabilityReason?: 'no-credentials' | 'no-adapter';
  pricing: 'published' | 'prompt-only' | 'none';
  freeTier?: FreeTier;
}

export interface CatalogProvider {
  name: string;
  models: number;
  availability: 'live' | 'stub';
  availabilityReason?: 'no-credentials' | 'no-adapter';
  freeTier?: FreeTier;
}

export interface ModelsResponse {
  data: CatalogModel[];
  providers: CatalogProvider[];
}

export interface PublicConfig {
  endpoints: { chat: string };
  payment: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    receiver: string;
    issuer?: string;
    facilitator: string;
    binding: string;
    header: string;
  };
  routing: { strategy: string; maxAttempts: number; skipUnconfiguredProviders: boolean };
  pricing: { currency: string; markupBps: number };
  metering: { enabled: boolean; source: string };
  apiKeys: { supported: boolean; reason: string };
}

export interface RequestPricing {
  currency: string;
  providerCostUsd: number;
  markupBps: number;
  customerPriceUsd: number;
  platformFeeUsd: number;
}

export type ActivityOutcome =
  | 'served'
  | 'stub'
  | 'payment-required'
  | 'payment-rejected'
  | 'error';

export interface ActivityRecord {
  id: string;
  at: string;
  outcome: ActivityOutcome;
  httpStatus: number;
  latencyMs: number;
  requestId?: string;
  model?: string;
  provider?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  pricing?: RequestPricing;
  pricingUnavailable?: string;
  metering?: { status: string; reason?: string; customer?: string };
  routing?: { strategy: string; chain: string[]; attempts: number };
  payment: {
    status: 'none' | 'verified' | 'rejected';
    paymentId?: string;
    payer?: string;
    asset: string;
    amount: string;
    network: string;
  };
  error?: string;
}

export interface ActivitySummary {
  requests: number;
  served: number;
  stub: number;
  paymentRequired: number;
  paymentRejected: number;
  errors: number;
  verifiedPayments: number;
  attributedPayers: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerCostUsd: number;
  customerPriceUsd: number;
  platformFeeUsd: number;
  unpricedRequests: number;
  meteredEvents: number;
  byProvider: { provider: string; requests: number; totalTokens: number }[];
  byModel: { model: string; requests: number; totalTokens: number }[];
}

export interface Retention {
  persistence: string;
  retained: number;
}

export interface ActivityResponse {
  data: ActivityRecord[];
  summary: ActivitySummary;
  retention: Retention;
}

export interface PaymentRecord {
  id: string;
  at: string;
  status: 'none' | 'verified' | 'rejected';
  asset: string;
  amount: string;
  network: string;
  txHash?: string;
  payer?: string;
  model?: string;
  provider?: string;
  totalTokens?: number;
  customerPriceUsd?: number;
  httpStatus: number;
}

export interface PaymentsResponse {
  data: PaymentRecord[];
  retention: Retention;
}

export interface KeysResponse {
  supported: boolean;
  data: { id: string; name: string; createdAt: string }[];
  reason: string;
}

/** The x402 payment request inside a challenge. */
export interface PaymentTerms {
  network: string;
  receiver: string;
  rewardDrops: string;
  nonce: string;
  expiresAt: string;
  asset?: string;
  issuer?: string;
}

export interface X402Challenge {
  scheme: string;
  payment: PaymentTerms;
  token: string;
}

export interface ChatResponse {
  model?: string;
  modelProvider?: string;
  stub?: boolean;
  costPer1MTokens?: number;
  /** The gateway answers with the text at the top level, not in OpenAI `choices`. */
  content?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  pricing?: RequestPricing;
  pricingUnavailable?: string;
  metering?: { status?: string; reason?: string; customer?: { status?: string; key?: string } };
  routing?: { strategy?: string; chain?: string[]; attempts?: number };
  requestId?: string;
  error?: string;
  message?: string;
}

/** An HTTP error carrying whatever the gateway said about it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const detail =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : res.statusText;
    throw new ApiError(res.status, `${path} failed: ${detail}`, body);
  }
  return body as T;
}

export const api = {
  config: (signal?: AbortSignal) => getJson<PublicConfig>('/v1/config', signal),
  models: (signal?: AbortSignal) => getJson<ModelsResponse>('/v1/models', signal),
  activity: (limit = 100, signal?: AbortSignal) =>
    getJson<ActivityResponse>(`/v1/activity?limit=${limit}`, signal),
  payments: (limit = 100, signal?: AbortSignal) =>
    getJson<PaymentsResponse>(`/v1/payments?limit=${limit}`, signal),
  keys: (signal?: AbortSignal) => getJson<KeysResponse>('/v1/keys', signal),
};

/** What one leg of the x402 handshake returned. */
export interface ChatAttempt {
  status: number;
  /** Present on a 402: the challenge to satisfy. */
  challenge?: X402Challenge;
  /** Present otherwise: the gateway's JSON response. */
  body?: ChatResponse;
}

/**
 * POST /v1/chat, optionally with a payment.
 *
 * This is the only console call that can cost money, and it is the real
 * endpoint — the quickstart playground runs the same handshake a curl user
 * would. A 402 is a normal outcome here, not an error, so it is returned
 * rather than thrown.
 */
export async function chat(
  body: unknown,
  paymentHeader?: string,
  signal?: AbortSignal
): Promise<ChatAttempt> {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(paymentHeader !== undefined && { 'X-PAYMENT': paymentHeader }),
    },
    body: JSON.stringify(body),
    signal,
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (res.status === 402) {
    return { status: res.status, challenge: json as X402Challenge };
  }
  return { status: res.status, body: json as ChatResponse };
}
