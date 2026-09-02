/**
 * QuickNodeFacilitator — REAL XRP Ledger payment verification (in-process).
 *
 * This is the real on-ledger verifier behind the `Facilitator` seam. It does
 * NOT call a hosted facilitator service and it NEVER signs anything for the
 * payer. Instead it verifies a submitted XRP Ledger payment directly against
 * an XRPL JSON-RPC endpoint (a QuickNode endpoint, the public testnet node,
 * or any other rippled node) using plain `fetch` — the same house pattern as
 * packages/server/src/llm/deepseek.ts: injectable fetchImpl, AbortController
 * deadline, stable machine-readable reason codes. No new dependencies.
 *
 * Scheme implemented: the T54 "exact" scheme.
 *   1. The server returns a 402 challenge (network, receiver, amount, nonce).
 *   2. The PAYER signs and submits a real XRPL `Payment` transaction with
 *      their OWN wallet (testnet: https://xrpl.org/resources/dev-tools.html).
 *      The payment's MemoData (or InvoiceID) hex-encodes the challenge nonce,
 *      which binds this payment to THIS challenge — replay protection.
 *   3. The payer retries the request with X-PAYMENT: { "txHash": "<hash>",
 *      "payment": <the challenge's payment request> }.
 *   4. We fetch the transaction from the ledger via JSON-RPC and check every
 *      field against the challenge (checklist below). For XRP `Payment`
 *      transactions settlement already happened on-ledger when the tx was
 *      confirmed, so verify == settle; there is no separate settlement step.
 *
 * WHY IN-PROCESS INSTEAD OF AN NPM SDK (verified facts, 2026-09-02):
 *   - npm `x402-xrpl` v0.3.2 is verified real and actively maintained
 *     (published 2026-08-25). Its server-side integration (`requirePayment`
 *     Express middleware from "x402-xrpl/express") does NOT verify anything
 *     itself — it delegates every verify/settle decision to a separate
 *     facilitator service via HTTP (`/verify` + `/settle`, see the package's
 *     `FacilitatorClient`), or to an in-process facilitator it does not ship.
 *   - `@xrpl-x402/server` v0.1.1 likewise delegates all verification to a
 *     gateway facilitator service and requires seller registration there.
 *   - The only hosted facilitator (T54 testnet) is explicitly best-effort
 *     with no SLA — not for production.
 *   We do not want production to depend on a second service we do not control,
 *   so verification is implemented in-process against the ledger, following
 *   the T54 verification checklist. When the team later deploys its own
 *   facilitator service, swapping this seam for the SDK's FacilitatorClient
 *   is the upgrade path.
 *
 * VERIFICATION CHECKLIST (from the T54 xrpl-scheme spec) — ALL must pass:
 *   1. validated ledger entry only     — result.validated === true
 *   2. TransactionType === 'Payment'
 *   3. Destination === challenge receiver
 *   4. Amount matches the challenge exactly (XRP drops string; IOU value + issuer for RLUSD)
 *   5. network id matches the challenge (tx NetworkID === expected: xrpl:1 -> 1)
 *   6. nonce/invoice binding present and matching (MemoData or InvoiceID
 *      hex-encodes THIS challenge's nonce) — reject unbound or mismatched
 *   7. challenge not expired (expiresAt bounds how long a payment is accepted)
 *   8. not a replay (tx hash never seen before — in-memory Set for the MVP;
 *      the usage-ledger task will make this persistent)
 *
 * FAIL-CLOSED GUARANTEE: any RPC/network/parse/timeout failure returns
 * `valid: false` with reason code `facilitator-failure`. We NEVER trust a
 * client-provided payment status — only ledger data we fetched ourselves.
 */

import { randomUUID } from 'crypto';
import {
  CreatePaymentRequestOptions,
  Facilitator,
  PaymentRequest,
  PaymentVerification,
  SubmittedPayment,
} from './facilitator';

/** Canonical 40-hex XRPL currency code for RLUSD (kept next to the spec). */
export const RLUSD_HEX_CODE = '524C555344000000000000000000000000000000';

/** Known display symbols -> canonical 40-hex currency codes (IOU assets). */
const KNOWN_IOU_CODES: Record<string, string> = { RLUSD: RLUSD_HEX_CODE };

export interface QuickNodeFacilitatorOptions {
  /** XRPL network id used in challenges, e.g. "xrpl:1" (testnet). */
  network: string;
  /** Address that collects payments (PAYMENT_RECEIVER). */
  receiver: string;
  /** Per-request amount: XRP drops, or IOU value for RLUSD (PAYMENT_REWARD_DROPS). */
  rewardDrops: string;
  /** XRPL JSON-RPC endpoint (XRPL_RPC_URL) — QuickNode or any public node. */
  rpcUrl: string;
  /** Payment asset: "XRP" (default) or an IOU like "RLUSD" (PAYMENT_ASSET). */
  asset?: string;
  /** IOU issuer (RLUSD_ISSUER) — required when asset is an issued currency. */
  issuer?: string;
  /** Hard deadline for one ledger RPC call, in ms. Default 5000. */
  timeoutMs?: number;
  /** Inject a fetch for tests (defaults to Node's global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests (defaults to Date.now). */
  now?: () => number;
}

/** Shape of the X-PAYMENT header JSON the real verifier expects. */
interface SubmittedXrplPayment {
  txHash?: unknown;
  payment?: unknown;
}

/** Loose view of a rippled `tx` method response we care about. */
interface LedgerTxJson {
  validated?: unknown;
  TransactionType?: unknown;
  Destination?: unknown;
  Amount?: unknown;
  NetworkID?: unknown;
  Memos?: unknown;
  InvoiceID?: unknown;
}

/** Result of one ledger lookup (the tx method). */
type LedgerFetch = { kind: 'found'; tx: LedgerTxJson } | { kind: 'not-found' };

/** Network/RPC problems are failures, not verdicts — fail closed. */
class RpcFailure extends Error {
  constructor(readonly why: string) {
    super(`XRPL RPC failure: ${why}`);
    this.name = 'RpcFailure';
  }
}

/** True when the value is a valid 64-char XRPL transaction hash. */
function isTxHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value);
}

/** Map a CAIP-2 network id ("xrpl:0" | "xrpl:1") to the tx NetworkID number. */
function expectedNetworkId(network: string): number | null {
  if (network === 'xrpl:1') return 1; // testnet
  if (network === 'xrpl:0') return 0; // mainnet
  return null; // unknown network — fail closed, never assume
}

/** Resolve an asset display symbol ("RLUSD") to its 40-hex currency code. */
function resolveIouHexCode(asset: string): string {
  const upper = asset.toUpperCase();
  if (/^[0-9A-F]{40}$/.test(upper)) return upper; // already a canonical code
  const known = KNOWN_IOU_CODES[upper];
  if (known) return known;
  throw new Error(
    `Unsupported payment asset "${asset}" — use "XRP", "RLUSD", or a 40-hex currency code.`
  );
}

/** Normalize an IOU value for comparison: "1.0" and "1" and "01" all mean 1. */
function normalizeIouValue(value: string): string {
  let v = value.trim();
  if (v.includes('.')) {
    v = v.replace(/0+$/, ''); // strip trailing zeros
    v = v.replace(/\.$/, ''); // strip a trailing dot
  }
  return v;
}

/**
 * Real XRP Ledger facilitator. Behaves exactly like the mock behind the same
 * `Facilitator` seam, but verifies payments on the actual ledger.
 */
export class QuickNodeFacilitator implements Facilitator {
  readonly name = 'quicknode-facilitator';

  /** Replay guard: hashes of payments we already accepted (MVP, in-memory). */
  private readonly usedTxHashes = new Set<string>();

  private readonly rpcUrl: string;
  private readonly asset: string;
  private readonly issuer: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: QuickNodeFacilitatorOptions) {
    if (!options.rpcUrl) {
      throw new Error('QuickNodeFacilitator requires an XRPL_RPC_URL.');
    }
    const asset = options.asset ?? 'XRP';
    if (asset !== 'XRP') {
      // Fail fast at startup: an IOU without its issuer would reject every
      // payment at runtime with a confusing reason. Resolve now so a bad
      // symbol also fails here, not mid-request.
      resolveIouHexCode(asset);
      if (!options.issuer) {
        throw new Error(
          `Payment asset "${asset}" is an issued currency — RLUSD_ISSUER is required.`
        );
      }
    }
    this.rpcUrl = options.rpcUrl;
    this.asset = asset;
    this.issuer = options.issuer;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Issue a fresh payment request: nonce = timestamp + random UUID. */
  async createPaymentRequest(
    options: CreatePaymentRequestOptions
  ): Promise<PaymentRequest> {
    return {
      network: options.network,
      receiver: options.receiver,
      rewardDrops: options.rewardDrops,
      nonce: `${Date.now()}-${randomUUID()}`,
      expiresAt: new Date(this.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
      asset: this.asset,
      // Only advertise the issuer for issued currencies (RLUSD).
      issuer: this.asset === 'XRP' ? undefined : this.issuer,
    };
  }

  /**
   * Verify a submitted payment against the active challenge. Runs the full
   * T54 checklist; every failure returns a stable `reason` code.
   */
  async verifyPayment(
    payment: SubmittedPayment,
    paymentRequest: PaymentRequest
  ): Promise<PaymentVerification> {
    // 7. The challenge expires 5 minutes after it was issued — a payment
    //    cannot be accepted against an expired challenge.
    const expiresAtMs = Date.parse(paymentRequest.expiresAt);
    if (Number.isNaN(expiresAtMs) || this.now() > expiresAtMs) {
      return { valid: false, reason: 'payment-request-expired' };
    }

    // Malformed X-PAYMENT: must be an object carrying a real tx hash.
    const submitted = (payment ?? {}) as SubmittedXrplPayment;
    if (!isTxHash(submitted.txHash)) {
      return { valid: false, reason: 'malformed-payment' };
    }
    const txHash = submitted.txHash;

    // 8. Replay guard — never accept the same on-ledger payment twice.
    if (this.usedTxHashes.has(txHash)) {
      return { valid: false, reason: 'duplicate-payment' };
    }

    // 1-6. Fetch the transaction from the ledger and check every field.
    //      Any RPC failure throws RpcFailure and is caught below -> FAIL CLOSED.
    let fetched: LedgerFetch;
    try {
      fetched = await this.fetchLedgerTx(txHash);
    } catch (err) {
      const why =
        err instanceof RpcFailure
          ? err.why
          : err instanceof Error
            ? err.message
            : String(err);
      return { valid: false, reason: `facilitator-failure:${why}` };
    }

    if (fetched.kind === 'not-found') {
      return { valid: false, reason: 'invalid-payment' }; // not on the ledger
    }
    const tx = fetched.tx;

    // 1. Validated ledger entry only — an unvalidated tx may disappear.
    if (tx.validated !== true) {
      return { valid: false, reason: 'invalid-payment' };
    }
    // 2. Must be a Payment transaction.
    if (tx.TransactionType !== 'Payment') {
      return { valid: false, reason: 'wrong-transaction-type' };
    }
    // 3. Destination must equal the challenge receiver.
    if (typeof tx.Destination !== 'string' || tx.Destination !== paymentRequest.receiver) {
      return { valid: false, reason: 'wrong-destination' };
    }
    // 4. Amount must match exactly (insufficient or over-payment both reject).
    if (!this.amountMatches(tx.Amount, paymentRequest)) {
      return { valid: false, reason: 'wrong-amount' };
    }
    // 5. Network id must match the challenge (fail closed on unknown ids).
    const expectedId = expectedNetworkId(paymentRequest.network);
    if (expectedId === null) {
      return { valid: false, reason: 'wrong-network' };
    }
    if (tx.NetworkID !== undefined && tx.NetworkID !== expectedId) {
      return { valid: false, reason: 'wrong-network' };
    }
    //    (When NetworkID is absent we accept: the tx was found on OUR
    //    configured node, which pins the network. The operator configures
    //    XRPL_RPC_URL to match XRPL_NETWORK.)
    // 6. Nonce/invoice binding: MemoData or InvoiceID must hex-encode THIS
    //    challenge's nonce. Reject unbound or mismatched payments.
    const binding = this.bindingMatches(tx, paymentRequest.nonce);
    if (!binding.present) {
      return { valid: false, reason: 'unbound-payment' };
    }
    if (!binding.matches) {
      return { valid: false, reason: 'nonce-mismatch' };
    }

    // All checks passed — remember the hash so the same payment cannot be
    // replayed. (In-memory for the MVP; the usage-ledger task adds persistence.)
    this.usedTxHashes.add(txHash);
    return { valid: true };
  }

  /** RPC call to the ledger's `tx` method (the ONLY network this class makes). */
  private async fetchLedgerTx(txHash: string): Promise<LedgerFetch> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'tx',
          params: [{ transaction: txHash, binary: false }],
        }),
        signal: controller.signal,
      });
    } catch (err) {
      // Timeout when OUR timer fired, or when the underlying fetch aborted
      // (Node's fetch surfaces an AbortError for both cases). Duck-type the
      // error name — inside Jest's VM, DOMException is not `instanceof Error`.
      const errObj = err as { name?: unknown; message?: unknown };
      const aborted =
        controller.signal.aborted ||
        (typeof errObj?.name === 'string' && errObj.name === 'AbortError');
      if (aborted) {
        throw new RpcFailure(`timeout after ${this.timeoutMs}ms`);
      }
      throw new RpcFailure(
        `network error: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new RpcFailure(`HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new RpcFailure('non-JSON response');
    }
    const result = (body as { result?: unknown })?.result;
    if (typeof result !== 'object' || result === null) {
      throw new RpcFailure('malformed RPC response (no result)');
    }
    const r = result as Record<string, unknown>;
    // A clean "txn not found" is a verdict (the payment does not exist),
    // anything else in the error field is an infra failure -> fail closed.
    if (r.status === 'error') {
      if (r.error === 'txnNotFound' || r.error === 'transactionNotFound') {
        return { kind: 'not-found' };
      }
      throw new RpcFailure(`RPC error: ${String(r.error ?? 'unknown')}`);
    }
    return { kind: 'found', tx: r as LedgerTxJson };
  }

  /** Amount check: XRP (drops string) exact match; IOU value+issuer match. */
  private amountMatches(amount: unknown, req: PaymentRequest): boolean {
    const asset = req.asset ?? 'XRP';
    if (asset === 'XRP') {
      // XRP payments carry the amount as a drops string, e.g. "1000000".
      return typeof amount === 'string' && amount === req.rewardDrops;
    }
    // IOU payments (RLUSD) carry { currency, value, issuer }.
    if (typeof amount !== 'object' || amount === null) return false;
    const a = amount as Record<string, unknown>;
    const expectedCurrency = resolveIouHexCode(asset);
    return (
      a.currency === expectedCurrency &&
      typeof a.value === 'string' &&
      typeof a.issuer === 'string' &&
      a.issuer === req.issuer &&
      normalizeIouValue(a.value) === normalizeIouValue(req.rewardDrops)
    );
  }

  /** MemoData / InvoiceID must hex-encode the challenge nonce. */
  private bindingMatches(
    tx: LedgerTxJson,
    nonce: string
  ): { present: boolean; matches: boolean } {
    const expectedHex = Buffer.from(nonce, 'utf8').toString('hex').toLowerCase();

    // Collect every binding candidate the tx carries.
    const candidates: string[] = [];
    if (typeof tx.InvoiceID === 'string') candidates.push(tx.InvoiceID);
    if (Array.isArray(tx.Memos)) {
      for (const entry of tx.Memos) {
        const memo = (entry as { Memo?: { MemoData?: unknown } })?.Memo;
        if (typeof memo?.MemoData === 'string') candidates.push(memo.MemoData);
      }
    }
    if (candidates.length === 0) return { present: false, matches: false };

    for (const candidate of candidates) {
      const hex = candidate.toLowerCase();
      // Valid hex AND it hex-decodes to exactly our nonce (MemoData style)
      // OR the raw hex equals hex(nonce) (InvoiceID style).
      const decodesToNonce =
        /^[0-9a-f]+$/.test(hex) &&
        Buffer.from(hex, 'hex').toString('utf8') === nonce;
      if (decodesToNonce || hex === expectedHex) {
        return { present: true, matches: true };
      }
    }
    return { present: true, matches: false };
  }
}