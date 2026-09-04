/**
 * Usage metering + platform fee, end to end over HTTP.
 *
 * Every request goes through the real x402 handshake (MockFacilitator), so
 * these tests also prove the ordering the task requires: payment verified ->
 * provider answered -> tokens normalized -> usage reported -> price computed
 * -> response. One injected fetch answers for both the LLM provider and
 * OpenMeter, dispatching on the URL, which is how each test proves what was
 * (and was not) sent where.
 *
 * The routed model is OVHcloud's Qwen3.5-397B-A17B: 0.71 USD per 1M prompt
 * tokens and 4.25 per 1M completion tokens, both from OVHcloud's public
 * catalog. With the canned usage below (12 prompt / 5 completion) that is
 * (12 x 0.71 + 5 x 4.25) / 1e6 = 0.00002977 USD of provider cost.
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { loadConfig, ServerConfig } from '../src/config';
import {
  Facilitator,
  PaymentRequest,
  PaymentVerification,
  SubmittedPayment,
} from '../src/facilitator/facilitator';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import { X_PAYMENT_HEADER, X402Challenge } from '../src/x402';

const METER_URL = 'https://meter.test';

/** The XRPL account a real facilitator would report as having paid. */
const PAYER = 'rPayerAddr1234567890abcdefghijklmn';

/**
 * A facilitator that attributes payments, like QuickNode (tx sender) and T54
 * (`payer`) do. The mock facilitator deliberately cannot, so this is the only
 * way to exercise the attributed path over HTTP.
 */
class AttributingFacilitator implements Facilitator {
  readonly name = 'attributing';
  private readonly inner = new MockFacilitator();

  createPaymentRequest(options: Parameters<Facilitator['createPaymentRequest']>[0]) {
    return this.inner.createPaymentRequest(options);
  }

  async verifyPayment(
    payment: SubmittedPayment,
    paymentRequest: PaymentRequest
  ): Promise<PaymentVerification> {
    const verification = await this.inner.verifyPayment(payment, paymentRequest);
    if (!verification.valid) return verification;
    return { ...verification, paymentId: `tx-${paymentRequest.nonce}`, payer: PAYER };
  }
}

const BASE = {
  paymentReceiver: 'rMOCKRECEIVERaddress00000000000000000',
  network: 'xrpl:1',
  rewardDrops: '1000000',
  logLevel: 'error' as const,
  routingSkipUnconfiguredProviders: true,
  // OVHcloud's anonymous tier is the only configured provider here, so the
  // route is deterministic.
  ovhAllowAnonymous: true,
  openmeterUrl: METER_URL,
  openmeterApiKey: 'om-test-key',
};

function buildApp(overrides: Partial<ServerConfig> = {}, fetchImpl?: typeof fetch): Express {
  return createApp({
    facilitator: new MockFacilitator(),
    config: loadConfig({ ...BASE, ...overrides }),
    fetchImpl,
  });
}

/** The same app, but behind a facilitator that names the payer. */
function buildAttributedApp(
  overrides: Partial<ServerConfig> = {},
  fetchImpl?: typeof fetch
): Express {
  return createApp({
    facilitator: new AttributingFacilitator(),
    config: loadConfig({ ...BASE, ...overrides }),
    fetchImpl,
  });
}

const HELLO = { messages: [{ role: 'user', content: 'hello' }] };

/** A canned OpenAI-compatible completion. Pass null for "no usage block". */
function completion(usage: unknown = { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }) {
  return new Response(
    JSON.stringify({
      model: 'Qwen3.5-397B-A17B',
      choices: [{ message: { role: 'assistant', content: 'hi there' } }],
      ...(usage !== null && { usage }),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

type Reply = Response | ((init?: RequestInit) => Response | Promise<Response>);

/**
 * A fetch that answers for the LLM provider and for OpenMeter, recording both
 * so a test can assert what the meter received — and how many times the LLM
 * was called, which is how "a metering failure must not re-run the request"
 * is checked.
 */
function splitFetch(replies: { llm?: Reply; meter?: Reply; customer?: Reply } = {}) {
  const llmCalls: RequestInit[] = [];
  const meterCalls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const customerCalls: { url: string; body: Record<string, unknown> }[] = [];

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (String(url).startsWith(`${METER_URL}/v3/openmeter/customers`)) {
      customerCalls.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      const reply =
        replies.customer ?? new Response(JSON.stringify({ id: '01ABC' }), { status: 201 });
      return typeof reply === 'function' ? reply(init) : reply;
    }
    if (String(url).startsWith(METER_URL)) {
      meterCalls.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      const reply = replies.meter ?? new Response(null, { status: 204 });
      return typeof reply === 'function' ? reply(init) : reply;
    }
    llmCalls.push(init ?? {});
    const reply = replies.llm ?? completion();
    return typeof reply === 'function' ? reply(init) : reply;
  }) as unknown as typeof fetch;

  return { fetchImpl, llmCalls, meterCalls, customerCalls };
}

/** Step 1 of the x402 handshake: get a challenge and build the header value. */
async function payFor(app: Express, payload: Record<string, unknown>): Promise<string> {
  const res = await request(app).post('/v1/chat').send(payload).expect(402);
  const challenge = res.body as X402Challenge;
  return JSON.stringify({
    nonce: challenge.token,
    signature: 'test-signature',
    payment: challenge.payment,
  });
}

/** Step 2: submit the payment. Reuse the same header to replay a payment. */
function withPayment(app: Express, header: string, payload: Record<string, unknown>) {
  return request(app).post('/v1/chat').set(X_PAYMENT_HEADER, header).send(payload);
}

/** The whole handshake, for the common case. */
async function paidChat(app: Express, payload: Record<string, unknown> = HELLO) {
  return withPayment(app, await payFor(app, payload), payload);
}

describe('usage metering — the event that reaches OpenMeter', () => {
  it('reports one kong.llm_request event after a paid request is served', async () => {
    const { fetchImpl, meterCalls } = splitFetch();
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hi there');
    expect(res.body.metering).toEqual({ status: 'sent' });

    expect(meterCalls).toHaveLength(1);
    const { headers, body } = meterCalls[0];
    expect(headers.Authorization).toBe('Bearer om-test-key');
    expect(headers['Content-Type']).toBe('application/cloudevents+json');

    expect(body.type).toBe('kong.llm_request');
    expect(body.specversion).toBe('1.0');
    expect(body.source).toBe('sonpay');
    expect(typeof body.time).toBe('string');
    expect(body.data).toMatchObject({
      model: 'Qwen3.5-397B-A17B',
      provider: 'ovhcloud',
      input_tokens: 12,
      output_tokens: 5,
      total_tokens: 17,
      // The metered value the "LLM Tokens" meter sums ($.tokens).
      tokens: 17,
      payment_asset: 'XRP',
      type: 'total',
    });
  });

  it('carries the real payment as payment_id, request_id and subject', async () => {
    const { fetchImpl, meterCalls } = splitFetch();
    const app = buildApp({}, fetchImpl);
    const header = await payFor(app, HELLO);
    const nonce = (JSON.parse(header) as { nonce: string }).nonce;

    await withPayment(app, header, HELLO).expect(200);

    const data = meterCalls[0].body.data as Record<string, unknown>;
    expect(data.payment_id).toBe(nonce);
    expect(data.request_id).toBe(`sonpay:${nonce}`);
    expect(meterCalls[0].body.id).toBe(`sonpay:${nonce}`);
    // The mock facilitator cannot attribute a payer, so the customer is the
    // payment itself rather than an invented account name.
    expect(data.customer).toBe(`payment:${nonce}`);
    expect(meterCalls[0].body.subject).toBe(`payment:${nonce}`);
  });

  it('meters nothing for an unpaid request', async () => {
    const { fetchImpl, meterCalls, llmCalls } = splitFetch();
    await request(buildApp({}, fetchImpl)).post('/v1/chat').send(HELLO).expect(402);

    expect(llmCalls).toHaveLength(0);
    expect(meterCalls).toHaveLength(0);
  });

  it('meters nothing when the provider reported no token usage', async () => {
    // No usage block at all -> nothing real to meter, and nothing to price.
    const { fetchImpl, meterCalls } = splitFetch({ llm: () => completion(null) });
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hi there');
    expect(res.body.metering).toEqual({ status: 'skipped', reason: 'no-token-usage' });
    expect(res.body.pricingUnavailable).toBe('no-token-usage');
    expect(meterCalls).toHaveLength(0);
  });

  it('is off, and silent, when OpenMeter is not configured', async () => {
    const { fetchImpl, meterCalls } = splitFetch();
    const res = await paidChat(buildApp({ openmeterUrl: '', openmeterApiKey: '' }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.metering).toEqual({ status: 'disabled' });
    expect(meterCalls).toHaveLength(0);
    // Pricing is Sonpay's own job and keeps working without OpenMeter.
    expect(res.body.pricing.providerCostUsd).toBe(0.00002977);
  });

  it('does not meter a stub answer', async () => {
    // No provider configured -> the stub replies, and a stub burns no tokens.
    const { fetchImpl, meterCalls } = splitFetch();
    const res = await paidChat(
      buildApp({ ovhAllowAnonymous: false, routingSkipUnconfiguredProviders: false }, fetchImpl)
    );

    expect(res.status).toBe(200);
    expect(res.body.stub).toBe(true);
    expect(meterCalls).toHaveLength(0);
  });
});

describe('usage metering — customer attribution', () => {
  it('bills the verified payer, and registers it as a customer first', async () => {
    const { fetchImpl, meterCalls, customerCalls } = splitFetch();
    const res = await paidChat(buildAttributedApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.metering).toEqual({ status: 'sent', customer: { status: 'created' } });

    expect(customerCalls).toHaveLength(1);
    expect(customerCalls[0].url).toBe(`${METER_URL}/v3/openmeter/customers`);
    expect(customerCalls[0].body).toEqual({
      name: PAYER,
      key: PAYER,
      usage_attribution: { subject_keys: [PAYER] },
    });

    // The event's subject is what the customer claims — that is the whole
    // point of the upsert, and the reason an event is not an orphan.
    expect(meterCalls[0].body.subject).toBe(PAYER);
    expect((meterCalls[0].body.data as Record<string, unknown>).customer).toBe(PAYER);
  });

  it('ignores a customer the client asks to be billed as', async () => {
    // Attribution is server-derived. If a request body could pick the
    // customer, anyone could charge their tokens to someone else.
    const { fetchImpl, meterCalls, customerCalls } = splitFetch();
    const app = buildAttributedApp({}, fetchImpl);
    const payload = { ...HELLO, customer: 'rVictimAccount', subject: 'rVictimAccount' };
    await withPayment(app, await payFor(app, payload), payload).expect(200);

    expect(meterCalls[0].body.subject).toBe(PAYER);
    expect(customerCalls[0].body.key).toBe(PAYER);
    expect(JSON.stringify(meterCalls[0])).not.toContain('rVictimAccount');
  });

  it('registers a payer once, not once per request', async () => {
    const { fetchImpl, customerCalls } = splitFetch();
    const app = buildAttributedApp({}, fetchImpl);

    await paidChat(app);
    const second = await paidChat(app);

    expect(second.body.metering).toEqual({ status: 'sent', customer: { status: 'cached' } });
    expect(customerCalls).toHaveLength(1);
  });

  it('does not invent a customer for a payment nobody can attribute', async () => {
    // The mock facilitator names no payer, so the subject is the payment
    // itself — real and stable, but not a billable identity.
    const { fetchImpl, meterCalls, customerCalls } = splitFetch();
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.body.metering).toEqual({ status: 'sent' });
    expect(customerCalls).toHaveLength(0);
    expect(String(meterCalls[0].body.subject)).toMatch(/^payment:/);
  });

  it('leaves the customer list alone when auto-creation is off', async () => {
    // Operators who manage customers in the Konnect UI get exactly that:
    // usage still reported, nothing written to their customer list.
    const { fetchImpl, meterCalls, customerCalls } = splitFetch();
    const res = await paidChat(
      buildAttributedApp({ openmeterAutoCreateCustomers: false }, fetchImpl)
    );

    expect(res.body.metering).toEqual({ status: 'sent' });
    expect(customerCalls).toHaveLength(0);
    expect(meterCalls[0].body.subject).toBe(PAYER);
  });

  it('still reports usage when the customer upsert fails', async () => {
    const { fetchImpl, meterCalls } = splitFetch({
      customer: () => new Response('nope', { status: 500 }),
    });
    const res = await paidChat(buildAttributedApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.metering).toEqual({
      status: 'sent',
      customer: { status: 'failed', reason: 'http-500' },
    });
    expect(meterCalls).toHaveLength(1);
  });
});

describe('usage metering — duplicates and failures', () => {
  it('a replayed payment does not create a second usage event', async () => {
    const { fetchImpl, meterCalls, llmCalls } = splitFetch();
    const app = buildApp({}, fetchImpl);
    const header = await payFor(app, HELLO);

    const first = await withPayment(app, header, HELLO).expect(200);
    const second = await withPayment(app, header, HELLO).expect(200);

    expect(first.body.metering).toEqual({ status: 'sent' });
    expect(second.body.metering).toEqual({ status: 'duplicate' });
    // The request really was served twice; only the usage was deduplicated.
    expect(llmCalls).toHaveLength(2);
    expect(meterCalls).toHaveLength(1);
  });

  it('an OpenMeter rejection still returns the answer and never re-runs the model', async () => {
    const { fetchImpl, meterCalls, llmCalls } = splitFetch({
      meter: () => new Response('{"detail":"bad request"}', { status: 400 }),
    });
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hi there');
    expect(res.body.metering).toEqual({ status: 'failed', reason: 'http-400' });
    // The caller already paid for exactly one inference.
    expect(llmCalls).toHaveLength(1);
    expect(meterCalls).toHaveLength(1);
    // Money is still computed: pricing does not depend on OpenMeter.
    expect(res.body.pricing.platformFeeUsd).toBe(0.0000014885);
  });

  it('an unreachable OpenMeter still returns the answer', async () => {
    const { fetchImpl, llmCalls } = splitFetch({
      meter: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.metering).toEqual({ status: 'failed', reason: 'transport-error' });
    expect(llmCalls).toHaveLength(1);
  });

  it('a hanging OpenMeter times out instead of holding the response open', async () => {
    const { fetchImpl, llmCalls } = splitFetch({
      meter: (init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        }),
    });
    const res = await paidChat(buildApp({ openmeterTimeoutMs: 25 }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('hi there');
    expect(res.body.metering).toEqual({ status: 'failed', reason: 'timeout-25ms' });
    expect(llmCalls).toHaveLength(1);
  });
});

describe('platform fee — 5% on top of the provider cost', () => {
  it('returns provider cost, customer price and platform fee', async () => {
    const { fetchImpl } = splitFetch();
    const res = await paidChat(buildApp({}, fetchImpl));

    expect(res.body.pricing).toEqual({
      currency: 'USD',
      providerCostUsd: 0.00002977, // (12 x 0.71 + 5 x 4.25) / 1e6
      markupBps: 500,
      customerPriceUsd: 0.0000312585, // cost x 1.05
      platformFeeUsd: 0.0000014885, // 5% of cost
    });
    expect(res.body.pricingUnavailable).toBeUndefined();
  });

  it('honors PLATFORM_MARKUP_BPS', async () => {
    const { fetchImpl } = splitFetch();
    const res = await paidChat(buildApp({ platformMarkupBps: 250 }, fetchImpl));

    expect(res.body.pricing.markupBps).toBe(250);
    expect(res.body.pricing.customerPriceUsd).toBe(0.0000305143); // cost x 1.025
  });

  it('meters a model with no published price but refuses to invent one', async () => {
    // NVIDIA publishes no per-token rates, so the request is real usage with
    // no cost we are allowed to state.
    const { fetchImpl, meterCalls } = splitFetch();
    const res = await paidChat(
      buildApp({ ovhAllowAnonymous: false, nvidiaApiKey: 'nvapi-test' }, fetchImpl)
    );

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('nvidia');
    expect(res.body.pricing).toBeUndefined();
    expect(res.body.pricingUnavailable).toBe('model-has-no-published-price');
    // Usage is still recorded — unknown price does not mean unknown usage.
    expect(res.body.metering).toEqual({ status: 'sent' });
    expect((meterCalls[0].body.data as Record<string, unknown>).provider).toBe('nvidia');
  });
});
