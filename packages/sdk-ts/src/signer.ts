/**
 * Signing seam for the SDK.
 *
 * HARD CONSTRAINT (business plan): the SDK must never contain, generate, or
 * hardcode private keys. All signing happens in a caller-provided `XrplSigner`
 * owned by the payer. The SDK only receives the signature string and embeds it
 * in the X-PAYMENT submission.
 */
import { PaymentRequest } from './types';

/**
 * Anything that can sign a payment request for the payer.
 *
 * Implementations own ALL key material. The SDK never sees a private key, seed,
 * or mnemonic — it only hands the payment request to the signer and receives a
 * signature string back. Use `signPaymentRequest` with a hard wallet, an HSM,
 * a hosted signing service, an xrpl.js `Wallet`, anything.
 */
export interface XrplSigner {
  /** Public XRP address of the payer (informational only — never a secret). */
  readonly address?: string;
  /**
   * Produce the signature to embed in the X-PAYMENT submission for the given
   * payment request.
   *
   * The return value is opaque to the SDK — the mock facilitator accepts any
   * non-empty string, so tests / local dev can return a constant. Real
   * integrations typically sign the canonical JSON of the payment request
   * (e.g. `JSON.stringify(paymentRequest)`) with the payer's wallet. The exact
   * signature encoding expected by the real t54 facilitator is TBD at the
   * wiring-up step; keep this method's contract "whatever the verifier
   * expects" until then.
   */
  signPaymentRequest(paymentRequest: PaymentRequest): Promise<string> | string;
}

/** Minimal shape of an xrpl.js `Wallet` (duck-typed — no xrpl dependency). */
export interface XrplWalletLike {
  readonly address: string;
  /** xrpl.js Wallet.sign(message) -> { signature, hash } — hex signature. */
  sign(message: string): { signature: string };
}

/**
 * Adapter that signs payment requests with an existing xrpl.js `Wallet`
 * instance (or anything with the same `address` / `sign` shape).
 *
 * The wallet is constructed by the CALLER from their own seed/secret — this
 * class never sees key material, only the wallet object.
 */
export class XrplWalletSigner implements XrplSigner {
  readonly address: string;

  constructor(private readonly wallet: XrplWalletLike) {
    this.address = wallet.address;
  }

  signPaymentRequest(paymentRequest: PaymentRequest): string {
    // Sign the canonical JSON of the payment request — the terms the payer
    // commits to. xrpl.js Wallet.sign accepts a UTF-8 message and returns
    // { signature, hash }.
    return this.wallet.sign(JSON.stringify(paymentRequest)).signature;
  }
}