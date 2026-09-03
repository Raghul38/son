/**
 * x402 payment middleware for Express.
 *
 * Implements the x402 (SOLX) payment-gating flow for POST /v1/chat:
 *
 *   1. A request WITHOUT an X-PAYMENT header receives a 402 with a
 *      `WWW-Authenticate: x402` header and a challenge body (content type
 *      `application/vnd+http.x402.challenge+json`).
 *   2. The payer signs a payment for the facilitator's receiver address and
 *      retries with the same request plus an `X-PAYMENT` header (payment body,
 *      content type `application/vnd+http.x402+pseudotx`).
 *   3. The server hands the submitted payment + its embedded payment request
 *      to the facilitator, which verifies it. Valid -> the request proceeds to
 *      the model handler; invalid -> a fresh 402 challenge is returned.
 *
 * The server NEVER signs for the payer — it only requests a payment request
 * from the facilitator and verifies submitted payments. This is enforcement
 * of the business-plan constraint.
 */
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { Facilitator, PaymentRequest } from './facilitator/facilitator';
import { RLUSD_HEX_CODE } from './facilitator/quicknode-facilitator';
import { ServerConfig } from './config';
import { Logger } from './logger';

/** Header names and media types from the x402 wire spec. */
export const X_PAYMENT_HEADER = 'x-payment';
export const X402_SCHEME = 'x402';
export const CHALLENGE_CONTENT_TYPE = 'application/vnd+http.x402.challenge+json';
export const PAYMENT_CONTENT_TYPE = 'application/vnd+http.x402+pseudotx';

/** Body of the 402 challenge the server returns to an unpaid request. */
export interface X402Challenge {
  scheme: 'x402';
  /** The facilitator-signed payment request the payer must satisfy. */
  payment: PaymentRequest;
  /** Short-lived nonce (mirrors `payment.nonce` for convenience). */
  token: string;
}

declare global {
  // Express namespace augmentation is in server.ts via our own types; here we
  // attach state on the Request via a symbol-free optional property.
  // eslint-disable-next-line @typescript-eslint/no-namespace
}

/** Extra fields attached to the request once payment is verified. */
export interface PaymentState {
  verified: boolean;
  submissionType: 'none' | 'paid' | 'rejected';
}

/** Bump Request to carry our app state without global type surgery. */
export type PayRequest = Request & { payment?: PaymentState };

async function buildChallenge(facilitator: Facilitator, config: ServerConfig): Promise<X402Challenge> {
  const payment = await facilitator.createPaymentRequest({
    network: config.network,
    receiver: config.paymentReceiver,
    rewardDrops: config.rewardDrops,
  });
  return { scheme: 'x402', payment, token: payment.nonce };
}

function respondChallenge(res: Response, challenge: X402Challenge): void {
  res
    .status(402)
    .setHeader('WWW-Authenticate', X402_SCHEME)
    .setHeader('Content-Type', CHALLENGE_CONTENT_TYPE)
    .json(challenge);
}

function extractPaymentRequest(value: unknown): PaymentRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;

  // T54-style x402 v2 envelope: the terms live in `accepted` (not `payment`).
  if (typeof obj.accepted === 'object' && obj.accepted !== null) {
    const a = obj.accepted as Record<string, unknown>;
    if (typeof a.payTo !== 'string' || a.payTo === '') return null;
    const extra = (typeof a.extra === 'object' && a.extra !== null ? a.extra : {}) as Record<string, unknown>;
    // T54 uses the canonical 40-hex currency code for IOUs; offer the display
    // symbol "RLUSD" so the server terms comparision below can match.
    const asset = a.asset === RLUSD_HEX_CODE ? 'RLUSD' : (a.asset as string) ?? 'XRP';
    return {
      network: (a.network as string) ?? 'xrpl:1',
      receiver: a.payTo,
      rewardDrops: (a.amount as string) ?? '',
      nonce: (extra.invoiceId as string) ?? '',
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
      asset: asset === 'XRP' ? undefined : asset,
      issuer: (extra.issuer as string) ?? undefined,
    } as PaymentRequest;
  }

  const p = obj.payment;
  if (typeof p !== 'object' || p === null) return null;
  const pobj = p as Record<string, unknown>;
  if (typeof pobj.nonce !== 'string' || pobj.nonce.length === 0) return null;
  return pobj as unknown as PaymentRequest;
}

/**
 * When the payer submits a T54-style x402 v2 envelope, the facilitator expects
 * the WHOLE envelope as `paymentPayload` (the spec's PaymentPayload). Returns
 * the `accepted` copy (normalized) for the middleware's terms check, and the
 * full envelope for the facilitator.
 */
function splitX402Submission(
  value: unknown
): { accepted: Record<string, unknown> | null; envelope: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null) {
    return { accepted: null, envelope: {} };
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.accepted === 'object' && obj.accepted !== null) {
    return { accepted: obj.accepted as Record<string, unknown>, envelope: obj };
  }
  return { accepted: null, envelope: obj };
}

/**
 * The payer echoes the challenge's payment request back in X-PAYMENT, so the
 * terms it carries are CLIENT-SUPPLIED and must be bound to what this server
 * actually asked for before the facilitator uses them. Without this check a
 * payer can submit a self-authored payment request (its own receiver, a
 * 1-drop amount) and satisfy the on-ledger check with a payment to a wallet
 * it controls — the operator is paid nothing, but the request is served.
 *
 * Only the operator-configured terms are compared here; the nonce/expiry
 * still come from the payer (binding those needs a server-side challenge
 * store — see the usage-ledger roadmap item).
 */
function matchesServerTerms(value: unknown, config: ServerConfig): boolean {
  const expectedAsset = config.paymentAsset;
  const expectedIssuer = expectedAsset === 'XRP' ? '' : config.rlusdIssuer;

  // v1 shape: the payer echoes our PaymentRequest (`payment` field).
  const p = (value as Record<string, unknown>)?.payment as Record<string, unknown> | undefined;
  if (typeof p === 'object' && p !== null && typeof p.nonce === 'string') {
    const req = p as unknown as PaymentRequest;
    return (
      req.network === config.network &&
      req.receiver === config.paymentReceiver &&
      req.rewardDrops === config.rewardDrops &&
      (req.asset ?? 'XRP') === expectedAsset &&
      (req.issuer ?? '') === expectedIssuer
    );
  }

  // v2-shape (T54): terms live in `accepted`. Normalize the 40-hex currency
  // code back to the configured display asset for comparison.
  const { accepted } = splitX402Submission(value);
  if (!accepted) return false;
  const asset =
    accepted.asset === RLUSD_HEX_CODE
      ? 'RLUSD'
      : (accepted.asset as string) ?? 'XRP';
  const extra = (accepted.extra ?? {}) as Record<string, unknown>;
  return (
    (accepted.network as string) === config.network &&
    (accepted.payTo as string) === config.paymentReceiver &&
    (accepted.amount as string) === config.rewardDrops &&
    asset === expectedAsset &&
    ((extra.issuer as string) ?? '') === expectedIssuer
  );
}

/**
 * Build the x402 payment middleware. Runs before the chat handler and either
 * short-circuits with a 402 (unpaid / rejected) or marks the request paid and
 * calls next().
 */
export function x402PaymentMiddleware(
  facilitator: Facilitator,
  config: ServerConfig,
  log: Logger
): RequestHandler {
  return async (req: PayRequest, res: Response, next: NextFunction) => {
    const raw = req.headers[X_PAYMENT_HEADER];
    const hasPayment = typeof raw === 'string' && raw.length > 0;

    // A fresh challenge is (re)issued on every unpaid or invalid request.
    const challenge = await buildChallenge(facilitator, config);

    if (!hasPayment) {
      req.payment = { verified: false, submissionType: 'none' };
      log.info('payment_required', { path: req.path, method: req.method });
      respondChallenge(res, challenge);
      return;
    }

    let submitted: unknown;
    try {
      submitted = JSON.parse(raw as string);
    } catch {
      req.payment = { verified: false, submissionType: 'rejected' };
      log.warn('payment_unparseable', { path: req.path });
      respondChallenge(res, challenge);
      return;
    }

    const paymentRequest = extractPaymentRequest(submitted);
    if (!paymentRequest) {
      req.payment = { verified: false, submissionType: 'rejected' };
      log.warn('payment_missing_request', { path: req.path });
      respondChallenge(res, challenge);
      return;
    }

    if (!matchesServerTerms(submitted, config)) {
      req.payment = { verified: false, submissionType: 'rejected' };
      log.warn('payment_rejected', { path: req.path, reason: 'terms-mismatch' });
      respondChallenge(res, challenge);
      return;
    }

    // v2 (T54) envelopes carry the FULL x402 payload (paymentPayload) that the
    // facilitator must verify/settle; v1 carries the echoed PaymentRequest.
    const { envelope } = splitX402Submission(submitted);
    const facilitatorInput = envelope.accepted ? envelope : submitted;

    const verification = await facilitator.verifyPayment(
      facilitatorInput,
      paymentRequest
    );
    if (!verification.valid) {
      req.payment = { verified: false, submissionType: 'rejected' };
      log.warn('payment_rejected', {
        path: req.path,
        reason: verification.reason ?? 'unknown',
      });
      respondChallenge(res, challenge);
      return;
    }

    req.payment = { verified: true, submissionType: 'paid' };
    log.info('payment_verified', {
      path: req.path,
      nonce: paymentRequest.nonce.slice(0, 12),
    });
    next();
  };
}

export { PAYMENT_CONTENT_TYPE as X402_PAYMENT_CONTENT_TYPE };