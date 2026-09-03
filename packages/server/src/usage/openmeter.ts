/**
 * OpenMeter usage client — the ONLY thing Sonpay sends to OpenMeter.
 *
 * Division of responsibility (deliberate, and enforced by this file being the
 * whole integration): OpenMeter records USAGE. Sonpay keeps payment, routing
 * and pricing. No price, fee or payment decision is ever sent to OpenMeter or
 * read back from it; see src/pricing.ts for the money.
 *
 * WIRE FORMAT — CloudEvents 1.0 JSON, POSTed to the OpenMeter events endpoint:
 *
 *   { "specversion": "1.0",
 *     "type":        "kong.llm_request",   <- the meter's event_type
 *     "id":          "<request id>",       <- dedupe key (see below)
 *     "source":      "sonpay",
 *     "subject":     "<customer>",
 *     "time":        "<ISO-8601>",
 *     "data": { request_id, customer, model, provider, input_tokens,
 *               output_tokens, total_tokens, payment_id, payment_asset,
 *               tokens, type } }
 *
 * The target meter (verified live against the configured instance on
 * 2026-09-03) is:
 *   key "llm_tokens_total", name "LLM Tokens", event_type "kong.llm_request",
 *   aggregation SUM, value_property "$.tokens",
 *   dimensions: model, provider, type, http_status, service_id, route_id,
 *               ai_plugin_id, control_plane_id.
 * So `data.tokens` is the metered number and `data.model` / `data.provider` /
 * `data.type` are group-by dimensions. Kong's own AI plugin splits a call into
 * one "input" and one "output" event; Sonpay emits ONE event per served
 * request carrying the total, tagged `type: "total"`, which is why it must
 * never also emit per-part events — that would double count the meter.
 *
 * ENDPOINT: `OPENMETER_URL` + `OPENMETER_EVENTS_PATH`. For Kong Konnect
 * Metering & Billing that is the REGIONAL KONNECT API host plus
 * `/v3/openmeter/events` (e.g. https://in.api.konghq.com/v3/openmeter/events),
 * NOT a gateway proxy host — a serverless gateway hostname answers
 * `{"message":"no Route matched with those values"}` for every path. Self
 * hosted OpenMeter uses `/api/v1/events` on its own host.
 *
 * IDEMPOTENCY: the CloudEvents `id` is the dedupe key, and it is derived from
 * the payment (see buildRequestId), never random. A duplicate payment or a
 * replayed request therefore carries the SAME id and cannot inflate usage —
 * twice over, in fact: this client refuses to re-send an id it has already
 * sent, and OpenMeter deduplicates on (source, id) if one ever escapes.
 *
 * FAILURE POLICY: this client NEVER throws and never signals a retry of the
 * LLM call. The provider has already been paid for and has already answered
 * by the time we get here; losing a usage event must not cost the caller a
 * second inference. Failures return a status the handler logs.
 */

/** The usage payload for one served request. */
export interface LlmUsageEvent {
  /** Stable per-payment id; also the CloudEvents id, so it must be derived. */
  request_id: string;
  /** Who used the tokens — the CloudEvents subject. */
  customer: string;
  /** Model id that actually served the request. */
  model: string;
  /** Provider that actually served the request. */
  provider: string;
  /** Prompt tokens, when the provider reported them. */
  input_tokens?: number;
  /** Completion tokens, when the provider reported them. */
  output_tokens?: number;
  /** Total tokens as reported (or summed) from the provider's usage block. */
  total_tokens: number;
  /** The x402 payment that unlocked this request. */
  payment_id: string;
  /** Asset that payment was denominated in ("XRP" / "RLUSD"). */
  payment_asset: string;
  /** The metered value ($.tokens on the meter). Equals total_tokens. */
  tokens: number;
}

/** Outcome of one metering attempt. Never an exception. */
export type MeteringStatus =
  /** Accepted by OpenMeter. */
  | 'sent'
  /** Same request id already metered by this process — deliberately not re-sent. */
  | 'duplicate'
  /** No OpenMeter URL/key configured; metering is off. */
  | 'disabled'
  /** Nothing meterable (e.g. the provider reported no token usage). */
  | 'skipped'
  /** OpenMeter rejected the event or was unreachable. */
  | 'failed';

export interface MeteringResult {
  status: MeteringStatus;
  /** Stable reason for 'skipped' / 'failed'. Never contains the API key. */
  reason?: string;
}

export interface OpenMeterClientOptions {
  /** OPENMETER_URL. Empty disables metering entirely. */
  baseUrl: string;
  /** OPENMETER_API_KEY. Empty disables metering entirely. */
  apiKey: string;
  /** Path appended to baseUrl. Default '/v3/openmeter/events'. */
  eventsPath?: string;
  /** CloudEvents `source`. Default 'sonpay'. */
  source?: string;
  /** Hard deadline for the ingest call, ms. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch (tests / the server's shared fetch seam). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic event times in tests. */
  now?: () => Date;
  /** How many sent ids to remember for in-process dedupe. Default 10000. */
  dedupeCapacity?: number;
}

export const DEFAULT_OPENMETER_EVENTS_PATH = '/v3/openmeter/events';
export const OPENMETER_EVENT_TYPE = 'kong.llm_request';

/**
 * The CloudEvents id for a served request: stable for a given payment, so the
 * same payment can never be metered twice. Prefixed with the source name
 * because OpenMeter deduplicates on (source, id) and other producers (Kong's
 * AI plugin) write to the same meter.
 */
export function buildRequestId(source: string, paymentId: string): string {
  return `${source}:${paymentId}`;
}

/** Bounded FIFO set — remembers the last N ids without growing forever. */
class RecentIds {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly capacity: number) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.capacity) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }
}

export class OpenMeterClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly source: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sent: RecentIds;

  constructor(options: OpenMeterClientOptions) {
    const base = options.baseUrl.replace(/\/+$/, '');
    const path = options.eventsPath ?? DEFAULT_OPENMETER_EVENTS_PATH;
    this.url = base === '' ? '' : `${base}${path.startsWith('/') ? path : `/${path}`}`;
    this.apiKey = options.apiKey;
    this.source = options.source ?? 'sonpay';
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.sent = new RecentIds(options.dedupeCapacity ?? 10_000);
  }

  /** True when both a URL and a key are configured. */
  get enabled(): boolean {
    return this.url !== '' && this.apiKey !== '';
  }

  /** The CloudEvents `source` this client stamps on every event. */
  get eventSource(): string {
    return this.source;
  }

  /**
   * Send one usage event. Resolves to a status; never rejects, so a caller can
   * `await` it on the success path of a paid request without any risk of
   * turning a delivered answer into an error.
   */
  async record(event: LlmUsageEvent): Promise<MeteringResult> {
    if (!this.enabled) return { status: 'disabled' };
    if (this.sent.has(event.request_id)) return { status: 'duplicate' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          // OpenMeter accepts a single CloudEvent as application/cloudevents+json.
          'Content-Type': 'application/cloudevents+json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(this.toCloudEvent(event)),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Body text can echo the request but never the Authorization header;
        // still, only the status is kept so nothing unexpected reaches a log.
        return { status: 'failed', reason: `http-${res.status}` };
      }
      // Only remember ids OpenMeter actually accepted: an event we failed to
      // deliver has not been counted, so a later retry must be allowed
      // through (OpenMeter's own (source, id) dedupe covers the case where
      // the request landed but the response did not reach us).
      this.sent.add(event.request_id);
      return { status: 'sent' };
    } catch (err) {
      const aborted =
        controller.signal.aborted ||
        (err as { name?: unknown })?.name === 'AbortError';
      return {
        status: 'failed',
        reason: aborted ? `timeout-${this.timeoutMs}ms` : 'transport-error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Wrap the usage payload in the CloudEvents envelope OpenMeter expects. */
  private toCloudEvent(event: LlmUsageEvent): Record<string, unknown> {
    return {
      specversion: '1.0',
      type: OPENMETER_EVENT_TYPE,
      id: event.request_id,
      source: this.source,
      subject: event.customer,
      time: this.now().toISOString(),
      datacontenttype: 'application/json',
      data: {
        request_id: event.request_id,
        customer: event.customer,
        model: event.model,
        provider: event.provider,
        // Omitted rather than zeroed when a provider does not report them —
        // a fabricated 0 would be indistinguishable from a real 0.
        ...(event.input_tokens !== undefined && { input_tokens: event.input_tokens }),
        ...(event.output_tokens !== undefined && { output_tokens: event.output_tokens }),
        total_tokens: event.total_tokens,
        payment_id: event.payment_id,
        payment_asset: event.payment_asset,
        tokens: event.tokens,
        // The meter groups by `type`; Kong's plugin uses input/output, we emit
        // one whole-request event, so it is explicitly "total".
        type: 'total',
      },
    };
  }
}
