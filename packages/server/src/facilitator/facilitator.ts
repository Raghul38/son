/**
 * Facilitator abstraction.
 *
 * The facilitator is the t54 hosted XRPL service that settles payments on
 * behalf of the payer without the server ever seeing or signing with a
 * private key. The server only:
 *   1. asks the facilitator for a payment request (used to build the x402
 *      402 challenge), and
 *   2. asks the facilitator to verify a submitted payment.
 *
 * HARD CONSTRAINT: the server never signs for a payer; it only verifies and
 * settles via the facilitator. CUSTODIAL note: the facilitator is genuinely
 * custodial for THIS prototype — wallet handling outside the XRP Ledger is
 * the facilitator's domain, not the server's.
 */

/** A facilitator-signed request for payment. This is the payload the x402
 * challenge embeds so the payer knows exactly who to pay and how much. */
export interface PaymentRequest {
  /** XRPL network id, e.g. "xrpl:0" (mainnet) or "xrpl:1" (testnet). */
  network: string;
  /** Address that receives the payment (the facilitator's / operator's address). */
  receiver: string;
  /**
   * Amount requested. For XRP this is drops (1 XRP = 1_000_000 drops).
   * For an issued currency like RLUSD this is the currency value, e.g. "0.01".
   * The field name stayed "rewardDrops" to keep the x402 wire shape backwards
   * compatible; see `asset`/`issuer` below.
   */
  rewardDrops: string;
  /** Opaque nonce (invoice id) linking this request to a single challenge. */
  nonce: string;
  /** ISO-8601 timestamp after which the request is no longer valid. */
  expiresAt: string;
  /**
   * Payment asset — "XRP" (default) or an issued currency such as "RLUSD".
   * Optional for backwards compatibility: the mock facilitator omits it.
   */
  asset?: string;
  /**
   * Issuer of an issued currency (required when `asset` is an IOU like RLUSD).
   * Optional for backwards compatibility: XRP payments do not need it.
   */
  issuer?: string;
}

export interface CreatePaymentRequestOptions {
  network: string;
  receiver: string;
  rewardDrops: string;
}

export interface PaymentVerification {
  /** True when the submitted payment satisfies the active payment request. */
  valid: boolean;
  /** Human-readable reason when invalid. */
  reason?: string;
  /**
   * Settlement reference for an accepted payment — the on-ledger transaction
   * hash for XRPL payments. Optional: a facilitator that cannot supply one
   * leaves it out, and the caller falls back to the challenge nonce.
   * Attribution metadata only; it is NOT part of the verification verdict.
   */
  paymentId?: string;
  /**
   * Address that paid, when the facilitator can attribute the payment.
   * Optional for the same reason: unknown stays unknown, never invented.
   */
  payer?: string;
}

/** Anything a payer (or SDK) submits as the value of the X-PAYMENT header. */
export type SubmittedPayment = unknown;

/** A facilitator the server can settle against. */
export interface Facilitator {
  readonly name: string;
  /** Create a new payment request for the server to embed in a 402 challenge. */
  createPaymentRequest(
    options: CreatePaymentRequestOptions
  ): Promise<PaymentRequest>;
  /** Verify a payment submitted by the payer against the active payment request. */
  verifyPayment(
    payment: SubmittedPayment,
    paymentRequest: PaymentRequest
  ): Promise<PaymentVerification>;
}