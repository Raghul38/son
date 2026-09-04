/**
 * Tests for the console API (catalog, public config, request ledger).
 *
 * The ledger tests drive REAL requests through the app — the full x402
 * handshake with the MockFacilitator and an injected fetch standing in for the
 * provider — because the whole point of the recorder is that it reports what
 * happened rather than what someone told it happened. Nothing here touches the
 * network.
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { loadConfig, ServerConfig } from '../src/config';
import { ActivityLog } from '../src/activity';
import {
  Facilitator,
  PaymentRequest,
  PaymentVerification,
  SubmittedPayment,
} from '../src/facilitator/facilitator';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import { X_PAYMENT_HEADER, X402Challenge } from '../src/x402';

const METER_URL = 'https://meter.test';
const PAYER = 'rPayerAddr1234567890abcdefghijklmn';
const TX_HASH = 'A'.repeat(64);

/** A facilitator that attributes payments, as QuickNode and T54 both do. */
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
    return { ...verification, paymentId: TX_HASH, payer: PAYER };
  }
}

const BASE = {
  paymentReceiver: 'rMOCKRECEIVERaddress00000000000000000',
  network: 'xrpl:1',
  rewardDrops: '1000000',
  logLevel: 'error' as const,
  routingSkipUnconfiguredProviders: true,
  ovhAllowAnonymous: true,
  openmeterUrl: METER_URL,
  openmeterApiKey: 'om-test-key',
};

function completion() {
  return new Response(
    JSON.stringify({
      model: 'Qwen3.5-397B-A17B',
      choices: [{ message: { role: 'assistant', content: 'hi there' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/** One fetch for both the provider and OpenMeter, dispatching on the URL. */
function splitFetch(): typeof fetch {
  return (async (url: string) => {
    if (String(url).startsWith(METER_URL)) return new Response(null, { status: 204 });
    return completion();
  }) as unknown as typeof fetch;
}

function build(overrides: Partial<ServerConfig> = {}, ledger?: ActivityLog): Express {
  return createApp({
    facilitator: new AttributingFacilitator(),
    config: loadConfig({ ...BASE, ...overrides }),
    fetchImpl: splitFetch(),
    ledger,
  });
}

const HELLO = { messages: [{ role: 'user', content: 'hello' }] };

/** The full handshake: 402 challenge, then the same request with X-PAYMENT. */
async function paidChat(
  app: Express,
  payload: Record<string, unknown> = HELLO,
  expectStatus = 200
) {
  const res = await request(app).post('/v1/chat').send(payload).expect(402);
  const challenge = res.body as X402Challenge;
  return request(app)
    .post('/v1/chat')
    .set(
      X_PAYMENT_HEADER,
      JSON.stringify({
        nonce: challenge.token,
        signature: 'test-signature',
        payment: challenge.payment,
      })
    )
    .send(payload)
    .expect(expectStatus);
}

describe('GET /v1/config — what a client needs to pay this gateway', () => {
  it('publishes the payment terms and the routing/pricing setup', async () => {
    const res = await request(build()).get('/v1/config').expect(200);

    expect(res.body.endpoints).toEqual({ chat: '/v1/chat' });
    expect(res.body.payment).toMatchObject({
      scheme: 'x402',
      network: 'xrpl:1',
      asset: 'XRP',
      amount: '1000000',
      receiver: BASE.paymentReceiver,
      facilitator: 'attributing',
      header: 'X-PAYMENT',
    });
    expect(res.body.routing).toEqual({
      strategy: 'cheapest',
      maxAttempts: 2,
      skipUnconfiguredProviders: true,
    });
    expect(res.body.pricing).toEqual({ currency: 'USD', markupBps: 500 });
    expect(res.body.metering).toEqual({ enabled: true, source: 'sonpay' });
  });

  it('carries the RLUSD issuer only when RLUSD is the asset', async () => {
    const xrp = await request(build()).get('/v1/config').expect(200);
    expect(xrp.body.payment.issuer).toBeUndefined();

    const rlusd = await request(
      build({ paymentAsset: 'RLUSD', rlusdIssuer: 'rIssuer000000000000000000000000000' })
    )
      .get('/v1/config')
      .expect(200);
    expect(rlusd.body.payment.issuer).toBe('rIssuer000000000000000000000000000');
  });

  it('leaks no secret', async () => {
    const res = await request(
      build({ openmeterApiKey: 'kpat_supersecret', llmApiKey: 'sk-secret', nvidiaApiKey: 'nvapi-x' })
    )
      .get('/v1/config')
      .expect(200);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('kpat_supersecret');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('nvapi-x');
    // Metering is still reported as on — the flag, never the credential.
    expect(res.body.metering.enabled).toBe(true);
  });
});

describe('GET /v1/models — the catalog', () => {
  it('returns every model in the router-core table with its published rates', async () => {
    const res = await request(build()).get('/v1/models').expect(200);

    const qwen = res.body.data.find((m: { id: string }) => m.id === 'Qwen3.5-397B-A17B');
    expect(qwen).toMatchObject({
      provider: 'ovhcloud',
      inputCostPer1MTokens: 0.71,
      outputCostPer1MTokens: 4.25,
      contextWindow: 262_144,
      pricing: 'published',
      availability: 'live', // anonymous tier is enabled in BASE
    });
    expect(qwen.capabilities).toContain('chat');
  });

  it('reports an unpublished price as unknown rather than free or zero', async () => {
    const res = await request(build({ nvidiaApiKey: 'nvapi-test' })).get('/v1/models').expect(200);

    const nvidia = res.body.data.find((m: { provider: string }) => m.provider === 'nvidia');
    expect(nvidia.inputCostPer1MTokens).toBeUndefined();
    expect(nvidia.outputCostPer1MTokens).toBeUndefined();
    expect(nvidia.pricing).toBe('none');
    expect(nvidia.freeTier).toEqual({
      name: 'Free developer tier',
      limit: '~40 requests/min, no card',
      active: true,
    });
  });

  it('separates "no credentials" from "this server cannot call it at all"', async () => {
    const res = await request(build({ ovhAllowAnonymous: false })).get('/v1/models').expect(200);
    const by = (id: string) => res.body.data.find((m: { id: string }) => m.id === id);

    // An adapter exists, but nothing is configured for it.
    expect(by('deepseek-v3')).toMatchObject({
      availability: 'stub',
      availabilityReason: 'no-credentials',
    });
    expect(by('Qwen3.5-397B-A17B')).toMatchObject({
      availability: 'stub',
      availabilityReason: 'no-credentials',
    });
    // No adapter at all: a key would not help.
    expect(by('gpt-4o-mini')).toMatchObject({
      availability: 'stub',
      availabilityReason: 'no-adapter',
    });
  });

  it('summarises providers for the landing page', async () => {
    const res = await request(build()).get('/v1/models').expect(200);

    const ovh = res.body.providers.find((p: { name: string }) => p.name === 'ovhcloud');
    expect(ovh).toMatchObject({ models: 2, availability: 'live' });
    expect(ovh.freeTier.limit).toBe('2 requests/min per IP per model');
  });
});

describe('GET /v1/activity — the request ledger', () => {
  it('is empty before anything happens', async () => {
    const res = await request(build()).get('/v1/activity').expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.summary.requests).toBe(0);
    expect(res.body.retention).toEqual({ persistence: 'memory', retained: 0 });
  });

  it('records what a served request really did', async () => {
    const app = build();
    await paidChat(app);

    const res = await request(app).get('/v1/activity').expect(200);
    // The 402 challenge and the paid retry are both requests.
    expect(res.body.data).toHaveLength(2);

    const [served, challenged] = res.body.data; // newest first
    expect(served).toMatchObject({
      outcome: 'served',
      httpStatus: 200,
      model: 'Qwen3.5-397B-A17B',
      provider: 'ovhcloud',
      requestId: `sonpay:${TX_HASH}`,
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      pricing: {
        currency: 'USD',
        providerCostUsd: 0.00002977,
        markupBps: 500,
        customerPriceUsd: 0.0000312585,
        platformFeeUsd: 0.0000014885,
      },
      metering: { status: 'sent' },
      payment: {
        status: 'verified',
        paymentId: TX_HASH,
        payer: PAYER,
        asset: 'XRP',
        amount: '1000000',
        network: 'xrpl:1',
      },
    });
    expect(served.routing.chain).toContain('Qwen3.5-397B-A17B');
    expect(typeof served.latencyMs).toBe('number');

    expect(challenged).toMatchObject({
      outcome: 'payment-required',
      httpStatus: 402,
      payment: { status: 'none' },
    });
    expect(challenged.model).toBeUndefined();
  });

  it('tells a rejected payment apart from a missing one', async () => {
    const app = build();
    await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify({ payment: { nonce: 'never-issued' } }))
      .send(HELLO)
      .expect(402);

    const res = await request(app).get('/v1/activity').expect(200);
    expect(res.body.data[0]).toMatchObject({
      outcome: 'payment-rejected',
      httpStatus: 402,
      payment: { status: 'rejected' },
    });
    expect(res.body.summary.paymentRejected).toBe(1);
    expect(res.body.summary.paymentRequired).toBe(0);
  });

  it('marks a stub answer as a stub, with no usage and no price', async () => {
    const app = build({ ovhAllowAnonymous: false, routingSkipUnconfiguredProviders: false });
    await paidChat(app);

    const res = await request(app).get('/v1/activity').expect(200);
    expect(res.body.data[0]).toMatchObject({ outcome: 'stub', httpStatus: 200 });
    expect(res.body.data[0].usage).toBeUndefined();
    expect(res.body.data[0].pricing).toBeUndefined();
    expect(res.body.summary.stub).toBe(1);
    expect(res.body.summary.totalTokens).toBe(0);
  });

  it('records a rejected request as an error with its code', async () => {
    const app = build();
    await paidChat(app, { ...HELLO, capabilities: ['telepathy'] }, 400);

    const res = await request(app).get('/v1/activity').expect(200);
    expect(res.body.data[0]).toMatchObject({
      outcome: 'error',
      httpStatus: 400,
      error: 'UNKNOWN_CAPABILITY',
    });
    expect(res.body.summary.errors).toBe(1);
  });

  it('sums tokens, cost and fee across requests', async () => {
    const app = build();
    await paidChat(app);
    await paidChat(app);

    const { summary } = (await request(app).get('/v1/activity').expect(200)).body;
    expect(summary.served).toBe(2);
    expect(summary.verifiedPayments).toBe(2);
    expect(summary.attributedPayers).toBe(1); // the same payer twice
    expect(summary.inputTokens).toBe(24);
    expect(summary.outputTokens).toBe(10);
    expect(summary.totalTokens).toBe(34);
    expect(summary.providerCostUsd).toBe(0.00005954);
    expect(summary.platformFeeUsd).toBe(0.000002977);
    expect(summary.byProvider).toEqual([{ provider: 'ovhcloud', requests: 2, totalTokens: 34 }]);
    // The same payment twice: OpenMeter counts one event, and so do we.
    expect(summary.meteredEvents).toBe(1);
  });

  it('honors ?limit and keeps only the newest rows', async () => {
    const app = build();
    await paidChat(app);
    await paidChat(app);

    const res = await request(app).get('/v1/activity?limit=1').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].outcome).toBe('served');
    // The summary always covers the whole retained window, not the page.
    expect(res.body.summary.requests).toBe(4);
  });

  it('is a bounded window, not an unbounded log', async () => {
    const ledger = new ActivityLog(3);
    const app = build({}, ledger);
    await paidChat(app); // 2 requests
    await paidChat(app); // 2 more

    const res = await request(app).get('/v1/activity').expect(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.retention).toEqual({ persistence: 'memory', retained: 3 });
  });
});

describe('GET /v1/payments — the payment projection', () => {
  it('shows asset, amount, transaction hash and status', async () => {
    const app = build();
    await paidChat(app);

    const res = await request(app).get('/v1/payments').expect(200);
    expect(res.body.data[0]).toMatchObject({
      status: 'verified',
      asset: 'XRP',
      amount: '1000000',
      network: 'xrpl:1',
      txHash: TX_HASH,
      payer: PAYER,
      model: 'Qwen3.5-397B-A17B',
      totalTokens: 17,
      customerPriceUsd: 0.0000312585,
      httpStatus: 200,
    });
    expect(res.body.data[1]).toMatchObject({ status: 'none', httpStatus: 402 });
  });
});

describe('API keys', () => {
  it('says plainly that this gateway issues none', async () => {
    const res = await request(build()).get('/v1/keys').expect(200);
    expect(res.body.supported).toBe(false);
    expect(res.body.data).toEqual([]);
    expect(res.body.reason).toMatch(/x402/);
  });

  it('refuses to pretend it created or revoked one', async () => {
    const app = build();
    await request(app).post('/v1/keys').send({ name: 'ci' }).expect(501);
    const res = await request(app).delete('/v1/keys/anything').expect(501);
    expect(res.body.error).toBe('API_KEYS_NOT_SUPPORTED');
  });
});

describe('the console API changes nothing about the gateway', () => {
  it('still answers 404 for an unknown route', async () => {
    const res = await request(build()).post('/v1/chat/extra').send({}).expect(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('still gates /v1/chat behind a payment', async () => {
    const res = await request(build()).post('/v1/chat').send(HELLO).expect(402);
    expect(res.body.scheme).toBe('x402');
    expect(res.headers['www-authenticate']).toBe('x402');
  });

  it('answers /healthz without a payment', async () => {
    const res = await request(build()).get('/healthz').expect(200);
    expect(res.body.status).toBe('ok');
  });
});
