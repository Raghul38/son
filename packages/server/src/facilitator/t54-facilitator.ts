/**
 * T54Facilitator — hosted x402 XRPL payment facilitator (optional second
 * facilitator behind the `Facilitator` seam).
 *
 * This is the OPTIONAL hosted-facilitator path the business plan calls for
 * (Task 3, Part 1). It adapts OUR PaymentRequest <-> T54's x402 v2 wire
 * format and calls the T54 hosted facilitator's `/verify` and `/settle`
 * endpoints. It is selected only when the operator sets:
 *     PAYMENT_FACILITATOR=t54  AND  T54_FACILITATOR_URL=<hosted base URL>
 * so the existing zero-config MockFacilitator and the in-process
 * QuickNodeFacilitator keep working exactly as before. It never touches
 * QuickNodeFacilitator's behavior.
 *
 * WHAT WAS VERIFIED (2026-09-03, before any code was written):
 *   - Docs: https://xrpl-x402.t54.ai/docs/xrpl-scheme (XRPL Exact scheme,
 *     x402 v2 wire format, invoice binding rules) and
 *     https://xrpl-facilitator-testnet.t54.ai/openapi.json (the live hosted
 *     facilitator's OpenAPI spec — endpoints, request/response schemas).
 *   - The hosted facilitator's wire shape (from its OpenAPI spec):
 *       POST /verify  body: { paymentPayload, paymentRequirements, extensions? }
 *                     -> 200 { isValid, invalidReason?, payer?, extensions? }
 *       POST /settle  body: { paymentPayload, paymentRequirements, extensions? }
 *                     -> 200 { success, transaction, network, payer?, errorReason? }
 *     `paymentPayload` = { x402Version: 2, resource?, accepted: PaymentRequirements,
 *                          payload: { signedTxBlob }, extensions? }
 *     `PaymentRequirements` = { scheme: "exact", network: "xrpl:1", amount: "1000000",
 *                               asset: "XRP"|canonical-40-hex, payTo,
 *                               maxTimeoutSeconds: 600, extra: { sourceTag, invoiceId, issuer? } }
 *   - Live probing confirmed: `/verify` on a bad tx returns 200
 *     `{"isValid":false,"invalidReason":"invalid_payload","payer":null}` and
 *     `/settle` returns 200 `{"success":false,"transaction":"","network":"xrpl:1",
 *     "payer":null,"errorReason":"verify_failed:invalid_payload"}` — the
 *     hosted service never throws on bad input; it answers with structured
 *     verdicts. `/supported` lists {exact,xrpl:1} testnet and {exact,xrpl:0}
 *     mainnet.
 *   - WHY BOTH /verify AND /settle (documented per the task: "settle only if
 *     docs show verify-only is insufficient"): the docs' "Settlement
 *     Response" section says the PAYMENT-RESPONSE header carries
 *     { success, transaction, network, payer } — the tx hash that proves the
 *     payment actually MOVED comes only from settle. The merchant-express
 *     guide states the facilitator "does verify+settle by default" and the
 *     SDK's /settle body is the same spec envelope. `/settle` itself runs the
 *     verification checklist first and fails closed (returns
 *     `success:false` with `errorReason:"verify_failed:..."`, tx NOT
 *     submitted), so calling settle on an invalid payment is safe and
 *     atomic: on our side we call /verify first (for the deterministic
 *     `invalidReason`), and if valid we call /settle (which re-verifies and
 *     lands the funds). If the /settle call then fails (network/timeout/
 *     non-JSON), we fail closed: the funds may or may not have moved, so a
 *     free response is NOT given — the safest verdict is "invalid".
 *
 * FAIL-CLOSED GUARANTEE: any T54 error / non-JSON body / timeout / HTTP
 * error / malformed response returns `valid: false` with reason code
 * `facilitator-failure`. We never trust a client-provided payment status —
 * only the hosted facilitator's verdict.
 *
 * NO HARDCODED URLs: the base URL always comes from the environment
 * (T54_FACILITATOR_URL). No new dependencies: plain `fetch`, same as
 * quicknode-facilitator.ts and llm/deepseek.ts.
 */
import { randomUUID } from 'crypto';
import {
  CreatePaymentRequestOptions,
  Facilitator,
  PaymentRequest,
  PaymentVerification,
  SubmittedPayment,
} from './facilitator';
import { RLUSD_HEX_CODE } from './quicknode-facilitator';

/** The T54 hosted facilitator's documented invoice source tag (x402 spec). */
const DEFAULT_SOURCE_TAG = 804681468;
/** How long a challenge stays valid (matches the schema default). */
const MAX_TIMEOUT_SECONDS = 600;

/** Our PaymentRequest represents the amount; T54 calls it `amount`. */
interface T54Extra {
  sourceTag: number;
  invoiceId: string;
  issuer?: string;
}

/** T54's PaymentRequirements (from the OpenAPI spec / x402 scheme docs). */
interface T54PaymentRequirements {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: T54Extra;
}

/** T54's payment envelope — what the payer signs and submits. */
interface T54PaymentPayload {
  x402Version: 2;
  resource?: { url: string; description?: string | null; mimeType?: string | null };
  accepted: T54PaymentRequirements;
  payload: { signedTxBlob: string };
  extensions?: Record<string, unknown> | null;
}

/** Body posted to POST /verify. */
interface T54VerifyRequest {
  paymentPayload: T54PaymentPayload;
  paymentRequirements: T54PaymentRequirements;
  extensions?: Record<string, unknown> | null;
}

/** Verified /verify response. */
interface T54VerifyResponse {
  isValid?: unknown;
  invalidReason?: unknown;
  payer?: unknown;
}

/** Verified /settle response. */
interface T54SettleResponse {
  success?: unknown;
  transaction?: unknown;
  network?: unknown;
  payer?: unknown;
  errorReason?: unknown;
}

/** Shape of the X-PAYMENT header the client sends us (x402 v2 envelope). */
interface SubmittedT54Payment {
  x402Version?: unknown;
  accepted?: unknown;
  payload?: unknown;
  resource?: unknown;
  extensions?: unknown;
}

export interface T54FacilitatorOptions {
  /** Hosted facilitator base URL (T54_FACILITATOR_URL). No trailing slash. */
  baseUrl: string;
  /** XRPL network id used in challenges, e.g. "xrpl:1" (testnet). */
  network: string;
  /** Address that collects payments (PAYMENT_RECEIVER). */
  receiver: string;
  /** Per-request amount: XRP drops, or IOU value for RLUSD (PAYMENT_REWARD_DROPS). */
  rewardDrops: string;
  /** Payment asset: "XRP" (default) or an IOU like "RLUSD" (PAYMENT_ASSET). */
  asset?: string;
  /** IOU issuer (RLUSD_ISSUER) — required when asset is an issued currency. */
  issuer?: string;
  /** Hard deadline for one facilitator HTTP call, in ms. Default 10000. */
  timeoutMs?: number;
  /** Injectable fetch for tests (defaults to Node's global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
  /** Injectable expiry offset (ms) for the challenge; default 5 minutes. */
  expiresInMs?: number;
}

/** Network/HTTP problems are failures, not verdicts — fail closed. */
class T54Failure extends Error {
  constructor(readonly why: string) {
    super(`T54 facilitator failure: ${why}`);
    this.name = 'T54Failure';
  }
}

/** Path we advertise for the sent resource (the x402 `resource` field). */
const RESOURCE_PATH = 'paid:chat';

/** Each challenge remembers its invoice id so verification can bind it. */
interface PendingChallenge {
  invoiceId: string;
}

/**
 * Hosted x402 XRPL facilitator. Behaves like the mock/quicknode behind the
 * same `Facilitator` seam, but delegates verify+settle to the T54 hosted
 * service.
 */
export class T54Facilitator implements Facilitator {
  readonly name = 't54-facilitator';

  /** Challenges we issued -> their invoice id (start of replay protection). */
  private readonly pending = new Map<string, PendingChallenge>();

  private readonly baseUrl: string;
  private readonly network: string;
  private readonly receiver: string;
  private readonly rewardDrops: string;
  private readonly asset: string;
  private readonly issuer: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly expiresInMs: number;

  constructor(options: T54FacilitatorOptions) {
    if (!options.baseUrl) {
      throw new Error(
        'T54Facilitator requires T54_FACILITATOR_URL (the hosted facilitator base URL).'
      );
    }
    const asset = options.asset ?? 'XRP';
    if (asset !== 'XRP' && asset !== 'RLUSD') {
      // Only XRP and RLUSD are advertised by T54's supported pairs today.
      throw new Error(
        `T54Facilitator supports only "XRP" or "RLUSD" (got "${asset}").`
      );
    }
    if (asset !== 'XRP' && !options.issuer) {
      throw new Error(
        'T54Facilitator: RLUSD requires an issuer (RLUSD_ISSUER).'
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.network = options.network;
    this.receiver = options.receiver;
    this.rewardDrops = options.rewardDrops;
    this.asset = asset;
    this.issuer = options.issuer;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.expiresInMs = options.expiresInMs ?? 5 * 60 * 1000;
  }

  /**
   * Issue a fresh payment request. The invoice id (UNIQUE per challenge) is
   * remembered here so verification can require the payer's transaction to
   * bind to it (docs: invoice binding prevents replay attacks).
   */
  async createPaymentRequest(
    options: CreatePaymentRequestOptions
  ): Promise<PaymentRequest> {
    const invoiceId = `${Date.now()}-${randomUUID()}`;
    const request: PaymentRequest = {
      network: options.network,
      receiver: options.receiver,
      rewardDrops: options.rewardDrops,
      nonce: invoiceId,
      expiresAt: new Date(this.now() + this.expiresInMs).toISOString(),
      asset: this.asset,
      issuer: this.asset === 'XRP' ? undefined : this.issuer,
    };
    this.pending.set(request.nonce, { invoiceId });
    return request;
  }

  /**
   * Verify a submitted payment against the active challenge by asking the
   * hosted facilitator. FAIL-CLOSED: never returns `valid: true` unless the
   * facilitator itself says the payment is valid AND settled.
   */
  async verifyPayment(
    payment: SubmittedPayment,
    paymentRequest: PaymentRequest
  ): Promise<PaymentVerification> {
    // The x402 middleware already bound the client's payment terms to our
    // server config before calling us (matchesServerTerms), so the
    // `paymentRequest` we store is the one we issued.

    // 1. The challenge must exist and not be expired. (A payment cannot be
    //    accepted against an expired challenge.)
    const pending = this.pending.get(paymentRequest.nonce);
    const expiresAtMs = Date.parse(paymentRequest.expiresAt);
    if (!pending || Number.isNaN(expiresAtMs) || this.now() > expiresAtMs) {
      return { valid: false, reason: 'payment-request-expired' };
    }

    // 2. The X-PAYMENT body must carry the x402 v2 envelope.
    const submitted = (payment ?? {}) as SubmittedT54Payment;
    if (
      submitted.x402Version !== 2 ||
      typeof submitted.accepted !== 'object' ||
      submitted.accepted === null ||
      typeof submitted.payload !== 'object' ||
      submitted.payload === null
    ) {
      return { valid: false, reason: 'malformed-payment' };
    }
    const accepted = submitted.accepted as Record<string, unknown>;
    const payload = submitted.payload as Record<string, unknown>;
    if (typeof payload.signedTxBlob !== 'string' || payload.signedTxBlob === '') {
      return { valid: false, reason: 'malformed-payment' };
    }

    // 3. Build T54's payment requirements FROM OUR terms (never trust the
    //    client's accepted copy for what we demand).
    const requirements = this.toT54Requirements(paymentRequest);
    // The FULL x402 envelope is the spec's PaymentPayload — `/verify` and
    // `/settle` both expect it as `paymentPayload`.
    const paymentPayload = submitted as unknown as T54PaymentPayload;

    // 4. Ask the hosted facilitator to VERIFY the payment.
    let verified: boolean;
    let invalidReason: string | undefined;
    // Who paid, and the settlement reference — reported by T54 on both
    // /verify and /settle. Used to attribute usage to a customer; unknown
    // stays unknown rather than being invented.
    let payer: string | undefined;
    let paymentId: string | undefined;
    try {
      const verifyRes = await this.postJson<T54VerifyResponse>('/verify', {
        paymentPayload,
        paymentRequirements: requirements,
      });
      verified = verifyRes.isValid === true;
      invalidReason =
        typeof verifyRes.invalidReason === 'string'
          ? verifyRes.invalidReason
          : undefined;
      // Attribution only — the verdict above is what decides access.
      payer = typeof verifyRes.payer === 'string' ? verifyRes.payer : undefined;
    } catch (err) {
      // Any T54 error / non-JSON / timeout -> fail closed.
      return { valid: false, reason: this.failureReason(err) };
    }
    if (!verified) {
      return { valid: false, reason: invalidReason ?? 'invalid-payment' };
    }

    // 5. SETTLE the payment (this is what actually lands the funds and
    //    returns the tx hash — docs: settlement response carries
    //    { success, transaction, network, payer }). /settle re-runs the
    //    verification internally and fails closed, so this is safe.
    try {
      const settleRes = await this.postJson<T54SettleResponse>('/settle', {
        paymentPayload,
        paymentRequirements: requirements,
      });
      if (settleRes.success !== true) {
        const why =
          typeof settleRes.errorReason === 'string' ? settleRes.errorReason : 'settle-failed';
        return { valid: false, reason: why };
      }
      // The settlement response is the better source for both: it carries the
      // on-ledger tx hash, and its payer is the account that actually paid.
      if (typeof settleRes.transaction === 'string') paymentId = settleRes.transaction;
      if (typeof settleRes.payer === 'string') payer = settleRes.payer;
    } catch (err) {
      // The payment may or may not have settled — never grant free access.
      // Fail closed: the payer must retry.
      return { valid: false, reason: this.failureReason(err) };
    }

    // 6. Success. Forget the challenge so the same x402 envelope cannot be
    //    replayed (in-memory for the MVP; the usage-ledger task persists).
    this.pending.delete(paymentRequest.nonce);
    return { valid: true, ...(paymentId !== undefined && { paymentId }), ...(payer !== undefined && { payer }) };
  }

  /** Build T54's PaymentRequirements from OUR issued terms. */
  private toT54Requirements(req: PaymentRequest): T54PaymentRequirements {
    const asset = req.asset ?? 'XRP';
    // T54 wants the canonical 40-hex code for IOUs (docs: "For raw
    // paymentRequirements.asset, use the canonical XRPL currency code").
    const t54Asset = asset === 'RLUSD' ? RLUSD_HEX_CODE : 'XRP';
    const extra: T54Extra = {
      sourceTag: DEFAULT_SOURCE_TAG,
      invoiceId: this.pending.get(req.nonce)?.invoiceId ?? req.nonce,
    };
    if (asset !== 'XRP') {
      // IOUs also require the issuer in extra (docs).
      extra.issuer = req.issuer;
    }
    return {
      scheme: 'exact',
      network: req.network,
      amount: req.rewardDrops,
      asset: t54Asset,
      payTo: req.receiver,
      maxTimeoutSeconds: Math.floor(MAX_TIMEOUT_SECONDS),
      extra,
    };
  }

  /** POST a JSON body to a T54 endpoint and parse the JSON response. */
  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const errObj = err as { name?: unknown; message?: unknown };
      const aborted =
        controller.signal.aborted ||
        (typeof errObj?.name === 'string' && errObj.name === 'AbortError');
      if (aborted) {
        throw new T54Failure(`timeout after ${this.timeoutMs}ms`);
      }
      throw new T54Failure(
        `network error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new T54Failure(`HTTP ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new T54Failure('non-JSON response');
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new T54Failure('malformed response body');
    }
    return parsed as T;
  }

  /** Map a caught failure to the stable fail-closed reason code. */
  private failureReason(err: unknown): string {
    const why =
      err instanceof T54Failure
        ? err.why
        : err instanceof Error
          ? err.message
          : String(err);
    return `facilitator-failure:${why}`;
  }
}