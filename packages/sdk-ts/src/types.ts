/**
 * Wire types for the XRP-Pay Router HTTP API — the SDK's view of the server.
 *
 * Mirrors the server's own types where those live in packages/server (which the
 * SDK deliberately does not depend on — it is a client, not part of the
 * gateway). `Capability` is reused from @xrppay/router-core, the shared
 * single-source-of-truth for capability identifiers.
 */
import type { Capability } from '@xrppay/router-core';

/** Body of the 402 challenge the router returns to an unpaid request. */
export interface X402Challenge {
  scheme: 'x402';
  /** The facilitator-signed payment request the payer must satisfy. */
  payment: PaymentRequest;
  /** Short-lived nonce (equals `payment.nonce` on this server). */
  token: string;
}

/**
 * A facilitator-signed request for payment. Echoed VERBATIM back to the
 * server inside the X-PAYMENT submission — the server compares its terms
 * (network/receiver/amount/asset) with the ones it actually issued, so the
 * client must never rewrite this object.
 */
export interface PaymentRequest {
  /** XRPL network id, e.g. "xrpl:0" (mainnet) or "xrpl:1" (testnet). */
  network: string;
  /** Address that receives the payment. */
  receiver: string;
  /** Drops (XRP) or currency value (RLUSD). See server's facilitator docs. */
  rewardDrops: string;
  /** Opaque nonce (invoice id) binding payment to a single challenge. */
  nonce: string;
  /** ISO-8601 timestamp after which the request is no longer valid. */
  expiresAt: string;
  /** Payment asset — "XRP" (default) or an issued currency such as "RLUSD". */
  asset?: string;
  /** Issuer of an issued currency (required when `asset` is an IOU like RLUSD). */
  issuer?: string;
}

/**
 * The signed envelope sent as the X-PAYMENT header value.
 *
 * The server calls `JSON.parse()` on the raw header, so the SDK sends the
 * literal JSON string of this object (no base64) — this is the exact format
 * packages/server/src/x402.ts parses. Layout:
 *   - `nonce`     — the challenge token (the mock facilitator binds on it)
 *   - `signature` — opaque output of the caller-provided signer (any non-empty
 *                   string passes the mock; the real facilitator's exact
 *                   signature encoding is TBD with the t54 integration)
 *   - `payment`   — the challenge's payment request echoed verbatim
 *   - extra keys  — facilitator-specific fields may be merged in per call via
 *                   `chat(request, { paymentExtras })` (e.g. `txHash` for the
 *                   on-ledger verification scheme)
 */
export interface PaymentSubmission {
  nonce: string;
  signature: string;
  payment: PaymentRequest;
  [key: string]: unknown;
}

/** POST /v1/chat request body. Unknown fields are passed through. */
export interface RouterChatRequest {
  /** Chat messages in OpenAI format: [{ role, content }, ...]. */
  messages: unknown[];
  /** Capabilities the routed model must support (e.g. "vision"). */
  capabilities?: Capability[];
  /** Hard ceiling on model cost in USD per 1M input tokens. */
  maxCostPer1MTokens?: number;
  [key: string]: unknown;
}

/** POST /v1/chat 200 response body. Mirror of the server's chat handler. */
export interface RouterChatResponse {
  /** The routed (cheapest capable) model id, e.g. "deepseek-v3". */
  model: string;
  /** Provider / gateway that hosts the model, e.g. "deepseek". */
  modelProvider?: string;
  /** Cost of the chosen model in USD per 1M input tokens. */
  costPer1MTokens?: number;
  /** The model's reply text. */
  content: string;
  /** Token usage, when a real provider answered. */
  usage?: unknown;
  /** True when the server answered with its deterministic stub (no LLM key). */
  stub?: boolean;
  [key: string]: unknown;
}

/** Optional per-chat knobs. */
export interface ChatOptions {
  /**
   * Extra fields merged into the X-PAYMENT submission — e.g. `{ txHash }`
   * for the on-ledger verification scheme, where the caller submits a real
   * XRP Ledger Payment transaction (with the challenge nonce in MemoData or
   * InvoiceID) and the server verifies it on-ledger.
   */
  paymentExtras?: Record<string, unknown>;
}