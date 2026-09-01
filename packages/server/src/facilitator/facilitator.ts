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
  /** Amount requested, in XRP drops (1 XRP = 1_000_000 drops). */
  rewardDrops: string;
  /** Opaque nonce linking this request to a single challenge. */
  nonce: string;
  /** ISO-8601 timestamp after which the request is no longer valid. */
  expiresAt: string;
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