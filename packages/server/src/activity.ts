/**
 * The request ledger behind the dashboard, usage and payments pages.
 *
 * Everything here is OBSERVED, never simulated: one record is written when a
 * `/v1/chat` response finishes, from the payment state x402 attached to the
 * request and the JSON body the chat handler actually sent. That is why this
 * lives in a middleware instead of inside the handler — x402, the router, the
 * provider adapters and the OpenMeter client keep working exactly as before
 * and do not know the ledger exists.
 *
 * It is deliberately in-memory and bounded: a gateway that silently grows a
 * log forever is a leak, and durable billing history belongs in OpenMeter,
 * which already has it. Restarting the server empties this list, and the API
 * says so (`persistence: "memory"`).
 */
import { randomUUID } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { ServerConfig } from './config';
import { RequestPricing } from './pricing';
import { buildRequestId } from './usage/openmeter';
import { PayRequest, PaymentState } from './x402';

/** How a request ended. */
export type ActivityOutcome =
  /** Paid, routed to a real provider, answered. */
  | 'served'
  /** Answered by the model stub — no provider configured, no tokens burned. */
  | 'stub'
  /** 402: no payment was presented, so a challenge was issued. */
  | 'payment-required'
  /** 402: a payment was presented and the facilitator refused it. */
  | 'payment-rejected'
  /** Anything else (bad request, provider failure). */
  | 'error';

export interface ActivityUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ActivityPayment {
  status: 'none' | 'verified' | 'rejected';
  /** On-ledger transaction hash when the facilitator reported one. */
  paymentId?: string;
  /** The account that paid, when the facilitator could attribute it. */
  payer?: string;
  asset: string;
  /** Amount asked for: XRP drops, or the IOU value for RLUSD. */
  amount: string;
  network: string;
}

export interface ActivityRecord {
  /** Ledger row id. Unique per request, including replays of one payment. */
  id: string;
  at: string;
  outcome: ActivityOutcome;
  httpStatus: number;
  latencyMs: number;
  /**
   * The usage-event id this request produced — the same id OpenMeter
   * deduplicates on. Present only for a verified payment.
   */
  requestId?: string;
  model?: string;
  provider?: string;
  usage?: ActivityUsage;
  pricing?: RequestPricing;
  /** Why there is no `pricing`, in the pricing module's own vocabulary. */
  pricingUnavailable?: string;
  metering?: { status: string; reason?: string; customer?: string };
  routing?: { strategy: string; chain: readonly string[]; attempts: number };
  payment: ActivityPayment;
  /** Machine-readable error code for a failed request. */
  error?: string;
}

/** Totals across the retained window, for the dashboard's summary cards. */
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
  /** Served requests with real usage that no published rate could price. */
  unpricedRequests: number;
  meteredEvents: number;
  byProvider: { provider: string; requests: number; totalTokens: number }[];
  byModel: { model: string; requests: number; totalTokens: number }[];
}

/** Money is summed then rounded once, on the same 10-decimal grid as pricing. */
function roundUsd(value: number): number {
  return Number(value.toFixed(10));
}

/**
 * A bounded, newest-last ring of records.
 *
 * @param capacity How many requests to retain. Older rows are dropped.
 */
export class ActivityLog {
  private readonly records: ActivityRecord[] = [];

  constructor(private readonly capacity: number = 500) {}

  add(record: ActivityRecord): void {
    this.records.push(record);
    while (this.records.length > this.capacity) this.records.shift();
  }

  /** Newest first, which is the only order any of the pages want. */
  list(limit?: number): ActivityRecord[] {
    const newestFirst = this.records.slice().reverse();
    return limit === undefined ? newestFirst : newestFirst.slice(0, Math.max(0, limit));
  }

  get size(): number {
    return this.records.length;
  }

  summary(): ActivitySummary {
    const byProvider = new Map<string, { requests: number; totalTokens: number }>();
    const byModel = new Map<string, { requests: number; totalTokens: number }>();
    const payers = new Set<string>();
    const summary: ActivitySummary = {
      requests: this.records.length,
      served: 0,
      stub: 0,
      paymentRequired: 0,
      paymentRejected: 0,
      errors: 0,
      verifiedPayments: 0,
      attributedPayers: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerCostUsd: 0,
      customerPriceUsd: 0,
      platformFeeUsd: 0,
      unpricedRequests: 0,
      meteredEvents: 0,
      byProvider: [],
      byModel: [],
    };

    for (const r of this.records) {
      if (r.outcome === 'served') summary.served++;
      else if (r.outcome === 'stub') summary.stub++;
      else if (r.outcome === 'payment-required') summary.paymentRequired++;
      else if (r.outcome === 'payment-rejected') summary.paymentRejected++;
      else summary.errors++;

      if (r.payment.status === 'verified') summary.verifiedPayments++;
      if (r.payment.payer !== undefined) payers.add(r.payment.payer);

      summary.inputTokens += r.usage?.inputTokens ?? 0;
      summary.outputTokens += r.usage?.outputTokens ?? 0;
      summary.totalTokens += r.usage?.totalTokens ?? 0;

      if (r.pricing !== undefined) {
        summary.providerCostUsd += r.pricing.providerCostUsd;
        summary.customerPriceUsd += r.pricing.customerPriceUsd;
        summary.platformFeeUsd += r.pricing.platformFeeUsd;
      } else if (r.usage?.totalTokens !== undefined) {
        summary.unpricedRequests++;
      }

      if (r.metering?.status === 'sent') summary.meteredEvents++;

      if (r.provider !== undefined) {
        const p = byProvider.get(r.provider) ?? { requests: 0, totalTokens: 0 };
        p.requests++;
        p.totalTokens += r.usage?.totalTokens ?? 0;
        byProvider.set(r.provider, p);
      }
      if (r.model !== undefined) {
        const m = byModel.get(r.model) ?? { requests: 0, totalTokens: 0 };
        m.requests++;
        m.totalTokens += r.usage?.totalTokens ?? 0;
        byModel.set(r.model, m);
      }
    }

    summary.attributedPayers = payers.size;
    summary.providerCostUsd = roundUsd(summary.providerCostUsd);
    summary.customerPriceUsd = roundUsd(summary.customerPriceUsd);
    summary.platformFeeUsd = roundUsd(summary.platformFeeUsd);
    summary.byProvider = Array.from(byProvider, ([provider, v]) => ({ provider, ...v })).sort(
      (a, b) => b.requests - a.requests
    );
    summary.byModel = Array.from(byModel, ([model, v]) => ({ model, ...v })).sort(
      (a, b) => b.requests - a.requests
    );
    return summary;
  }
}

/** The subset of a `/v1/chat` 200 body the ledger reads back. */
interface ChatResponseBody {
  model?: unknown;
  modelProvider?: unknown;
  stub?: unknown;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  pricing?: RequestPricing;
  pricingUnavailable?: unknown;
  metering?: { status?: unknown; reason?: unknown; customer?: { status?: unknown } };
  routing?: { strategy?: unknown; chain?: unknown; attempts?: unknown };
  error?: unknown;
}

function paymentStatusOf(payment: PaymentState | undefined): ActivityPayment['status'] {
  if (payment?.verified === true) return 'verified';
  if (payment?.submissionType === 'rejected') return 'rejected';
  return 'none';
}

function outcomeOf(httpStatus: number, body: ChatResponseBody, paid: boolean): ActivityOutcome {
  if (httpStatus === 200) return body.stub === true ? 'stub' : 'served';
  if (httpStatus === 402) return paid ? 'payment-rejected' : 'payment-required';
  return 'error';
}

function usageOf(body: ChatResponseBody): ActivityUsage | undefined {
  const usage = body.usage;
  if (usage === undefined) return undefined;
  return {
    ...(usage.prompt_tokens !== undefined && { inputTokens: usage.prompt_tokens }),
    ...(usage.completion_tokens !== undefined && { outputTokens: usage.completion_tokens }),
    ...(usage.total_tokens !== undefined && { totalTokens: usage.total_tokens }),
  };
}

/** Build one ledger row from what the request and its response actually were. */
export function buildActivityRecord(input: {
  payment: PaymentState | undefined;
  httpStatus: number;
  body: unknown;
  latencyMs: number;
  config: ServerConfig;
  at?: Date;
}): ActivityRecord {
  const { payment, httpStatus, config } = input;
  const body = (typeof input.body === 'object' && input.body !== null
    ? input.body
    : {}) as ChatResponseBody;
  const status = paymentStatusOf(payment);
  const metering = body.metering;

  return {
    id: randomUUID(),
    at: (input.at ?? new Date()).toISOString(),
    outcome: outcomeOf(httpStatus, body, status === 'rejected'),
    httpStatus,
    latencyMs: input.latencyMs,
    ...(payment?.paymentId !== undefined && {
      requestId: buildRequestId(config.openmeterSource, payment.paymentId),
    }),
    ...(typeof body.model === 'string' && { model: body.model }),
    ...(typeof body.modelProvider === 'string' && { provider: body.modelProvider }),
    ...(usageOf(body) !== undefined && { usage: usageOf(body) }),
    ...(body.pricing !== undefined && { pricing: body.pricing }),
    ...(typeof body.pricingUnavailable === 'string' && {
      pricingUnavailable: body.pricingUnavailable,
    }),
    ...(metering !== undefined &&
      typeof metering.status === 'string' && {
        metering: {
          status: metering.status,
          ...(typeof metering.reason === 'string' && { reason: metering.reason }),
          ...(typeof metering.customer?.status === 'string' && {
            customer: metering.customer.status,
          }),
        },
      }),
    ...(body.routing !== undefined &&
      typeof body.routing.strategy === 'string' && {
        routing: {
          strategy: body.routing.strategy,
          chain: Array.isArray(body.routing.chain) ? (body.routing.chain as string[]) : [],
          attempts: typeof body.routing.attempts === 'number' ? body.routing.attempts : 0,
        },
      }),
    payment: {
      status,
      ...(payment?.paymentId !== undefined && { paymentId: payment.paymentId }),
      ...(payment?.payer !== undefined && { payer: payment.payer }),
      asset: payment?.asset ?? config.paymentAsset,
      amount: config.rewardDrops,
      network: config.network,
    },
    ...(httpStatus >= 400 && typeof body.error === 'string' && { error: body.error }),
  };
}

/**
 * Record every `/v1/chat` request in the ledger.
 *
 * Mounted in FRONT of the x402 middleware so a 402 is recorded too — "payment
 * status" is one of the columns the dashboard exists to show. The response
 * body is captured by wrapping `res.json`; nothing about the response the
 * caller receives changes.
 */
export function activityRecorder(ledger: ActivityLog, config: ServerConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    const sendJson = res.json.bind(res);
    let body: unknown;
    res.json = (payload: unknown) => {
      body = payload;
      return sendJson(payload);
    };
    res.on('finish', () => {
      ledger.add(
        buildActivityRecord({
          payment: (req as PayRequest).payment,
          httpStatus: res.statusCode,
          body,
          latencyMs: Date.now() - startedAt,
          config,
        })
      );
    });
    next();
  };
}

/** A payment-centric projection of the ledger, for the Payments page. */
export interface PaymentRecord {
  id: string;
  at: string;
  status: ActivityPayment['status'];
  asset: string;
  amount: string;
  network: string;
  txHash?: string;
  payer?: string;
  /** What the payment bought, when it bought anything. */
  model?: string;
  provider?: string;
  totalTokens?: number;
  customerPriceUsd?: number;
  httpStatus: number;
}

export function toPaymentRecords(records: readonly ActivityRecord[]): PaymentRecord[] {
  return records.map((r) => ({
    id: r.id,
    at: r.at,
    status: r.payment.status,
    asset: r.payment.asset,
    amount: r.payment.amount,
    network: r.payment.network,
    ...(r.payment.paymentId !== undefined && { txHash: r.payment.paymentId }),
    ...(r.payment.payer !== undefined && { payer: r.payment.payer }),
    ...(r.model !== undefined && { model: r.model }),
    ...(r.provider !== undefined && { provider: r.provider }),
    ...(r.usage?.totalTokens !== undefined && { totalTokens: r.usage.totalTokens }),
    ...(r.pricing !== undefined && { customerPriceUsd: r.pricing.customerPriceUsd }),
    httpStatus: r.httpStatus,
  }));
}
