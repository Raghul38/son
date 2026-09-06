/**
 * T54 Trustline client — OPTIONAL pre-execution underwriting for a paid
 * request.
 *
 * Trustline answers one question: should this agent's transaction be allowed
 * to execute? Sonpay asks it after the x402 payment has been verified and
 * BEFORE any provider tokens are spent, which is the only irreversible step
 * this server takes on its own.
 *
 * It is OFF unless BOTH T54_TRUSTLINE_BASE_URL and T54_TRUSTLINE_API_KEY are
 * set, and even then it only observes (logs the decision) until an operator
 * sets T54_TRUSTLINE_MODE=enforce. Nothing about x402, the QuickNode or T54
 * facilitators, the router, the providers or OpenMeter changes when it is off:
 * `assess()` returns { status: 'disabled' } without making a call.
 *
 * WHAT WAS VERIFIED LIVE (2026-09-06, against the real sandbox key, before
 * this file was written):
 *   - Base URL: `https://portal.t54.ai/api/v1`. Sandbox and production share
 *     it; the key prefix (`tl_sandbox_` / `tl_production_`) selects the
 *     environment. The `https://api-sandbox.t54.ai/api/v1` host named in some
 *     docs answers 404 {"detail":"Not Found"} for these paths.
 *   - Auth: `Authorization: Bearer tl_{env}_{key_id}.{secret}`. A bogus key
 *     answers 401 {"code":"invalid_api_key"}, so authentication is
 *     distinguishable from authorization.
 *   - POST /validation/assess-async -> 200 {schema_version:
 *     "underwriting_async_submission.v1", status:"pending",
 *     trustline_transaction_id:"tl_txn_…", job_id, poll_url,
 *     retry_after_seconds:3}. Requires the `underwriting:write` scope.
 *   - GET /underwriting/transactions/{id} -> the same transaction's status,
 *     and on `completed` a decision of APPROVE or DECLINE with risk_level,
 *     confidence, reason_brief and reasons. The docs say this poll needs no
 *     auth header; the live API answers 401 {"code":"invalid_api_key",
 *     "message":"Developer API key is required"} without one, so this client
 *     sends the key on BOTH calls.
 *   - POST /validation/assess (sync) answers 400
 *     `developer_api_key_requires_async_endpoint` for a developer key, which
 *     is why only the async pair is implemented.
 *   - The supplied sandbox key authenticates but is scope-denied today:
 *     both endpoints answer 403 {"code":"api_key_scope_denied"}. That path is
 *     handled like any other failure — see FAILURE POLICY.
 *
 * FAILURE POLICY — FAIL OPEN, deliberately. The caller has already paid on
 * ledger by the time this runs, so a Trustline outage, timeout, scope or
 * quota problem must not turn a settled payment into no answer. Anything that
 * is not an explicit DECLINE resolves to `unavailable` and the request
 * proceeds; only a decision Trustline actually returned can block one. This
 * mirrors the OpenMeter client: an external service is never allowed to take
 * the gateway down.
 *
 * IDEMPOTENCY: the `Idempotency-Key` is derived from the x402 payment, never
 * random, so a replayed request cannot open a second assessment for the same
 * payment — the same rule the usage meter follows.
 *
 * PRIVACY: prompt and completion text are NEVER sent. Trustline receives the
 * payment facts (amount, asset, receiver, network, payer), the routed model,
 * and the endpoint being called. Nothing a client puts in the request body
 * reaches it.
 *
 * NO HARDCODED URL OR KEY: both come from the environment, and the key is
 * never logged, never returned in a result and never published by the API.
 */

/** Where the API key says it is pointed. Derived from the key prefix. */
export type TrustlineEnvironment = 'sandbox' | 'production' | 'unknown';

/** What an operator wants a decision to do. */
export type TrustlineMode = 'observe' | 'enforce';

export type TrustlineStatus =
  /** Trustline returned decision APPROVE. */
  | 'approved'
  /** Trustline returned decision DECLINE. */
  | 'declined'
  /** Not configured — no call was made. */
  | 'disabled'
  /** Nothing to assess (no verified payment behind this request). */
  | 'skipped'
  /** Trustline could not be reached or could not decide. Fails open. */
  | 'unavailable';

export interface TrustlineResult {
  status: TrustlineStatus;
  /** Stable reason code for 'unavailable' / 'skipped'. Never the API key. */
  reason?: string;
  /** Trustline's own transaction id (`tl_txn_…`), when one was created. */
  transactionId?: string;
  /** 'low' | 'medium' | 'high' | 'critical', as returned. */
  riskLevel?: string;
  /** Consensus confidence 0..1, as returned. */
  confidence?: number;
  /** Public-safe rationale, as returned. */
  reasonBrief?: string;
  /** Allowlisted reason codes, as returned. */
  reasons?: string[];
}

/** The facts Sonpay knows about one paid request. No prompt text. */
export interface TrustlineAssessmentInput {
  /** The x402 payment that unlocked the request (tx hash or invoice nonce). */
  paymentId: string;
  /** Verified payer, when the facilitator could attribute one. */
  payer?: string;
  /** Amount as configured: XRP drops, or the IOU value for an issued currency. */
  amount: string;
  /** 'XRP' or an issued currency such as 'RLUSD'. */
  asset: string;
  /** Address that collected the payment. */
  receiver: string;
  /** CAIP-2 network id, e.g. 'xrpl:0'. */
  network: string;
  /** Model the router picked for this request. */
  model: string;
  /** Provider that would serve it. */
  provider: string;
  /** The endpoint being paid for. */
  resourceUrl: string;
}

export interface TrustlineClientOptions {
  /** T54_TRUSTLINE_BASE_URL, e.g. https://portal.t54.ai/api/v1. Empty = off. */
  baseUrl: string;
  /** T54_TRUSTLINE_API_KEY (tl_sandbox_… / tl_production_…). Empty = off. */
  apiKey: string;
  /** Stable id for this gateway as an agent (T54_TRUSTLINE_AGENT_ID). */
  agentId?: string;
  /** observe (default) or enforce. */
  mode?: TrustlineMode;
  /** Whole-assessment deadline in ms, submit + polling. Default 15000. */
  timeoutMs?: number;
  /** Injectable fetch (tests / the server's shared fetch seam). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests do not wait for real poll intervals. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TRUSTLINE_AGENT_ID = 'sonpay-gateway';
export const TRUSTLINE_ASSESS_PATH = '/validation/assess-async';
export const TRUSTLINE_TRANSACTIONS_PATH = '/underwriting/transactions';

/** Statuses that mean "keep polling" (from the async underwriting docs). */
const IN_FLIGHT: ReadonlySet<string> = new Set([
  'pending',
  'accepted',
  'queued',
  'running',
  'running_validators',
  'finalizing',
]);

/**
 * Statuses that pause for an Agentic Challenge. A challenge asks a human or
 * agent for more evidence; this client deliberately does not answer one, so it
 * stops and fails open rather than hanging a paid request.
 */
const CHALLENGE: ReadonlySet<string> = new Set([
  'requires_information',
  'information_submitted',
  'reassessing',
]);

/** Poll pacing guard rails around the server's `retry_after_seconds`. */
const MIN_POLL_MS = 250;
const MAX_POLL_MS = 5000;

/**
 * Which environment a key is bound to, from its documented prefix. Used by the
 * production safety rules — a sandbox key must not underwrite real payments.
 */
export function trustlineEnvironment(apiKey: string): TrustlineEnvironment {
  if (apiKey.startsWith('tl_sandbox_')) return 'sandbox';
  if (apiKey.startsWith('tl_production_')) return 'production';
  return 'unknown';
}

/** XRP is quoted in drops on the wire; Trustline wants the human amount. */
function humanAmount(amount: string, asset: string): number {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return asset.toUpperCase() === 'XRP' ? n / 1_000_000 : n;
}

/** Read a string field defensively — an unexpected body must never throw. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export class TrustlineClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly agentId: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly mode: TrustlineMode;

  constructor(options: TrustlineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.agentId = options.agentId ?? DEFAULT_TRUSTLINE_AGENT_ID;
    this.mode = options.mode ?? 'observe';
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** True when both a base URL and a key are configured. */
  get enabled(): boolean {
    return this.baseUrl !== '' && this.apiKey !== '';
  }

  /** Which Trustline environment the configured key belongs to. */
  get environment(): TrustlineEnvironment {
    return trustlineEnvironment(this.apiKey);
  }

  /**
   * Should a result stop the request? Only an explicit DECLINE, and only when
   * the operator asked for enforcement. Everything else proceeds.
   */
  blocks(result: TrustlineResult): boolean {
    return this.mode === 'enforce' && result.status === 'declined';
  }

  /**
   * Submit one paid request for underwriting and poll until Trustline decides
   * or the deadline passes. Never throws.
   */
  async assess(input: TrustlineAssessmentInput): Promise<TrustlineResult> {
    if (!this.enabled) return { status: 'disabled' };
    if (input.paymentId === '') return { status: 'skipped', reason: 'no-payment-id' };

    const deadline = Date.now() + this.timeoutMs;
    const submitted = await this.submit(input, deadline);
    if ('reason' in submitted) return { status: 'unavailable', reason: submitted.reason };

    return this.poll(submitted.transactionId, submitted.pollUrl, submitted.retryMs, deadline);
  }

  /** POST /validation/assess-async. */
  private async submit(
    input: TrustlineAssessmentInput,
    deadline: number
  ): Promise<
    | { transactionId: string; pollUrl: string; retryMs: number }
    | { reason: string }
  > {
    const res = await this.send(
      `${this.baseUrl}${TRUSTLINE_ASSESS_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          // Derived from the payment, never random: a replay of the same
          // payment replays the same assessment instead of opening a new one.
          'Idempotency-Key': `sonpay:${input.paymentId}`,
        },
        body: JSON.stringify(this.body(input)),
      },
      deadline
    );
    if (!res.ok) return { reason: res.reason };

    const body = res.body as Record<string, unknown> | undefined;
    const transactionId = str(body?.trustline_transaction_id);
    if (transactionId === undefined) return { reason: 'malformed-submission' };
    return {
      transactionId,
      pollUrl: str(body?.poll_url) ?? `${TRUSTLINE_TRANSACTIONS_PATH}/${transactionId}`,
      retryMs: this.retryMs(body?.retry_after_seconds),
    };
  }

  /** GET the transaction until it reaches a terminal state or time runs out. */
  private async poll(
    transactionId: string,
    pollUrl: string,
    firstRetryMs: number,
    deadline: number
  ): Promise<TrustlineResult> {
    let waitMs = firstRetryMs;
    for (;;) {
      if (Date.now() + waitMs >= deadline) {
        return { status: 'unavailable', reason: 'decision-timeout', transactionId };
      }
      await this.sleep(waitMs);

      const res = await this.send(
        this.resolve(pollUrl, transactionId),
        { method: 'GET', headers: { Authorization: `Bearer ${this.apiKey}` } },
        deadline
      );
      if (!res.ok) return { status: 'unavailable', reason: res.reason, transactionId };

      const body = (res.body ?? {}) as Record<string, unknown>;
      const status = str(body.status) ?? 'unknown';

      if (IN_FLIGHT.has(status)) {
        waitMs = this.retryMs(body.retry_after_seconds);
        continue;
      }
      if (CHALLENGE.has(status)) {
        // An Agentic Challenge needs evidence this client cannot supply.
        return { status: 'unavailable', reason: 'challenge-required', transactionId };
      }
      if (status !== 'completed') {
        // failed / expired / canceled / anything unrecognised.
        return { status: 'unavailable', reason: `status-${status}`, transactionId };
      }
      return this.decisionOf(body, transactionId);
    }
  }

  /** Read the decision block off a completed transaction. */
  private decisionOf(body: Record<string, unknown>, transactionId: string): TrustlineResult {
    // The decision may sit at the top level or inside `final_result`.
    const final = (body.final_result ?? {}) as Record<string, unknown>;
    const pick = (key: string): unknown => body[key] ?? final[key];

    const decision = str(pick('decision'))?.toUpperCase();
    const confidence = pick('confidence');
    const reasons = pick('reasons');
    const common = {
      transactionId,
      riskLevel: str(pick('risk_level')),
      confidence: typeof confidence === 'number' ? confidence : undefined,
      reasonBrief: str(pick('reason_brief')),
      reasons: Array.isArray(reasons)
        ? reasons.filter((r): r is string => typeof r === 'string')
        : undefined,
    };

    if (decision === 'APPROVE') return { status: 'approved', ...common };
    if (decision === 'DECLINE') return { status: 'declined', ...common };
    // Completed without a decision we recognise: never guess an approval.
    return { status: 'unavailable', reason: 'no-decision', ...common };
  }

  /** Trustline's async submission body (async underwriting API, v1). */
  private body(input: TrustlineAssessmentInput): Record<string, unknown> {
    return {
      assessment_type: 'transaction',
      agent_id: this.agentId,
      transaction_data: {
        transaction: {
          transaction_id: input.paymentId,
          amount: humanAmount(input.amount, input.asset),
          currency: input.asset,
          chain: input.network,
          recipient: input.receiver,
        },
        audit_context: {
          // Factual, and free of prompt text: what was paid for, not what was
          // asked. Trustline underwrites the payment, not the conversation.
          current_task:
            `Serve one paid inference request on ${input.resourceUrl} using model ` +
            `${input.model} (${input.provider}), unlocked by x402 payment ${input.paymentId}.`,
          reasoning_process:
            `The x402 payment of ${humanAmount(input.amount, input.asset)} ${input.asset} to ` +
            `${input.receiver} on ${input.network} was verified before this assessment` +
            `${input.payer !== undefined ? `, paid by ${input.payer}` : ''}. ` +
            'Provider tokens have not been spent yet.',
        },
        request_body: {
          http: { url: input.resourceUrl, method: 'POST' },
          // Payment and routing facts only — no prompt, no completion.
          body: {
            model: input.model,
            provider: input.provider,
            payment_id: input.paymentId,
            payment_asset: input.asset,
            network: input.network,
            ...(input.payer !== undefined && { payer: input.payer }),
          },
        },
      },
      metadata: {
        source: 'sonpay',
        environment: this.environment === 'production' ? 'production' : 'sandbox',
      },
    };
  }

  /**
   * Resolve a `poll_url` from the submission response. It is documented as a
   * root-relative path (`/api/v1/underwriting/transactions/…`), so it is
   * resolved against the configured base rather than appended to it.
   */
  private resolve(pollUrl: string, transactionId: string): string {
    try {
      return new URL(pollUrl, `${this.baseUrl}/`).toString();
    } catch {
      return `${this.baseUrl}${TRUSTLINE_TRANSACTIONS_PATH}/${transactionId}`;
    }
  }

  /** Clamp the server's suggested poll interval into something sane. */
  private retryMs(retryAfterSeconds: unknown): number {
    const seconds = typeof retryAfterSeconds === 'number' ? retryAfterSeconds : 0;
    return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, seconds * 1000));
  }

  /**
   * One HTTP call, bounded by the assessment deadline, reduced to a plain
   * verdict. Rejections, aborts, error statuses and non-JSON bodies all come
   * back as data so no caller has to guard a paid request with a try/catch.
   *
   * The reason code carries the API's own error code when it publishes one
   * (`api_key_scope_denied`, `invalid_api_key`, …) and never the key itself.
   */
  private async send(
    url: string,
    init: RequestInit,
    deadline: number
  ): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: 'decision-timeout' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const body = await res.json().catch(() => undefined);
      if (!res.ok) {
        const code = str((body as { detail?: { code?: unknown } } | undefined)?.detail?.code);
        return { ok: false, reason: code ?? `http-${res.status}` };
      }
      return { ok: true, body };
    } catch (err) {
      const aborted =
        controller.signal.aborted || (err as { name?: unknown })?.name === 'AbortError';
      return { ok: false, reason: aborted ? 'decision-timeout' : 'transport-error' };
    } finally {
      clearTimeout(timer);
    }
  }
}
