/**
 * Mock facilitator for local development and tests.
 *
 * In-memory, deterministic, and stateless across challenges except for a
 * per-process nonce counter. It does NOT talk to the XRP Ledger. A payment
 * is considered valid when it echoes the active challenge's nonce and carries
 * a non-empty `signature` — enough to exercise the full 402 -> sign -> retry
 * flow locally without any real funds.
 *
 * Swap this for the real t54 XRPL facilitator in server assembly; the
 * `Facilitator` interface is the seam.
 */
import {
  CreatePaymentRequestOptions,
  Facilitator,
  PaymentRequest,
  PaymentVerification,
  SubmittedPayment,
} from './facilitator';

const NONCE_PREFIX = 'mock-nonce-';

interface MockPaymentShape {
  nonce?: unknown;
  signature?: unknown;
}

export class MockFacilitator implements Facilitator {
  readonly name = 'mock-facilitator';
  private counter = 0;

  async createPaymentRequest(
    options: CreatePaymentRequestOptions
  ): Promise<PaymentRequest> {
    this.counter += 1;
    const now = Date.now();
    return {
      network: options.network,
      receiver: options.receiver,
      rewardDrops: options.rewardDrops,
      nonce: `${NONCE_PREFIX}${this.counter}-${now}`,
      expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), // 5 minutes
    };
  }

  async verifyPayment(
    payment: SubmittedPayment,
    paymentRequest: PaymentRequest
  ): Promise<PaymentVerification> {
    const p = (payment ?? {}) as MockPaymentShape;
    if (typeof p.nonce !== 'string' || p.nonce.length === 0) {
      return { valid: false, reason: 'missing-payment-nonce' };
    }
    if (p.nonce !== paymentRequest.nonce) {
      return { valid: false, reason: 'nonce-mismatch' };
    }
    if (typeof p.signature !== 'string' || p.signature.length === 0) {
      return { valid: false, reason: 'missing-payment-signature' };
    }
    return { valid: true };
  }
}