/**
 * Routing wiring tests: how the server drives router-core's strategies.
 *
 * Every request goes through the real x402 flow (MockFacilitator) so these
 * tests also prove routing still happens strictly AFTER payment verification.
 * No network: the DeepSeek adapter gets an injected fetch.
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { loadConfig, ServerConfig } from '../src/config';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import { X_PAYMENT_HEADER, X402Challenge } from '../src/x402';

const BASE = {
  paymentReceiver: 'rMOCKRECEIVERaddress00000000000000000',
  network: 'xrpl:1',
  rewardDrops: '1000000',
  logLevel: 'error' as const,
};

function buildApp(overrides: Partial<ServerConfig> = {}, fetchImpl?: typeof fetch): Express {
  return createApp({
    facilitator: new MockFacilitator(),
    config: loadConfig({ ...BASE, ...overrides }),
    fetchImpl,
  });
}

/** Two-step x402 handshake, returning the paid response. */
async function paidChat(app: Express, payload: Record<string, unknown>) {
  const challengeRes = await request(app).post('/v1/chat').send(payload).expect(402);
  const challenge = challengeRes.body as X402Challenge;
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
    .send(payload);
}

/** A fetch that answers with a canned OpenAI-compatible completion. */
function okFetch(content = 'real answer'): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        model: 'deepseek-chat',
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch;
}

/** A fetch that always fails with the given HTTP status. */
function failingFetch(status: number): typeof fetch {
  return (async () => new Response('nope', { status })) as unknown as typeof fetch;
}

describe('routing wiring — default (cheapest) strategy', () => {
  it('routes to the cheapest capable model and reports the decision', async () => {
    const res = await paidChat(buildApp(), {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('deepseek-v3');
    expect(res.body.stub).toBe(true);
    expect(res.body.routing.strategy).toBe('cheapest');
    expect(res.body.routing.chain[0]).toBe('deepseek-v3');
    expect(res.body.routing.attempts).toBe(0);
    expect(res.body.routing.tier).toBeUndefined();
  });

  it('still honors caller capabilities and cost ceiling', async () => {
    const res = await paidChat(buildApp(), {
      messages: [{ role: 'user', content: 'describe this image' }],
      capabilities: ['vision'],
      maxCostPer1MTokens: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('gpt-4o-mini');
  });

  it('returns 400 NO_ROUTE when the constraints exclude everything', async () => {
    const res = await paidChat(buildApp(), {
      messages: [{ role: 'user', content: 'hi' }],
      maxCostPer1MTokens: 0.01,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE', reason: 'no-model-under-cost-ceiling' });
  });

  it('falls back to "cheapest" for an unknown ROUTING_STRATEGY value', () => {
    expect(loadConfig({ ...BASE }).routingStrategy).toBe('cheapest');
    process.env.ROUTING_STRATEGY = 'not-a-strategy';
    try {
      expect(loadConfig().routingStrategy).toBe('cheapest');
    } finally {
      delete process.env.ROUTING_STRATEGY;
    }
  });
});

describe('routing wiring — tiered strategy', () => {
  const tiered = { routingStrategy: 'tiered' as const };

  it('classifies the prompt and returns the tier alongside the answer', async () => {
    const res = await paidChat(buildApp(tiered), {
      messages: [
        { role: 'user', content: 'Prove that sqrt(2) is irrational, step by step, formally.' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.routing.strategy).toBe('tiered');
    expect(res.body.routing.tier).toBe('REASONING');
    expect(res.body.routing.confidence).toBeGreaterThanOrEqual(0.85);
    expect(res.body.model).toBe('deepseek-v3'); // cheapest reasoning-capable model
  });

  it('keeps a trivial prompt on the SIMPLE tier', async () => {
    const res = await paidChat(buildApp(tiered), {
      messages: [{ role: 'user', content: 'what is the capital of France?' }],
    });
    expect(res.body.routing.tier).toBe('SIMPLE');
  });

  it('reads the system prompt for structured-output detection', async () => {
    const res = await paidChat(buildApp(tiered), {
      messages: [
        { role: 'system', content: 'Always reply with a JSON object.' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(res.body.routing.tier).toBe('MEDIUM');
  });

  it('survives a body whose messages are not chat objects', async () => {
    const res = await paidChat(buildApp(tiered), { messages: ['not-an-object', 42, null] });
    expect(res.status).toBe(200);
    expect(res.body.routing.tier).toBeDefined();
  });
});

describe('routing wiring — provider availability', () => {
  it('is off by default: an unconfigured provider still answers with the stub', async () => {
    const res = await paidChat(buildApp(), {
      messages: [{ role: 'user', content: 'describe this image' }],
      capabilities: ['vision'],
    });
    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('openai');
    expect(res.body.stub).toBe(true);
  });

  it('opt-in: refuses to route to a provider the server cannot call', async () => {
    const res = await paidChat(buildApp({ routingSkipUnconfiguredProviders: true }), {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE', reason: 'no-available-provider' });
  });

  it('opt-in with a key configured: routes to the configured provider', async () => {
    const app = buildApp(
      { routingSkipUnconfiguredProviders: true, llmApiKey: 'test-key' },
      okFetch()
    );
    const res = await paidChat(app, {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('deepseek');
    expect(res.body.stub).toBeUndefined();
    expect(res.body.content).toBe('real answer');
    expect(res.body.routing.attempts).toBe(1);
  });
});

describe('routing wiring — provider failures', () => {
  it('returns the provider error rather than silently serving a stub', async () => {
    const app = buildApp({ llmApiKey: 'test-key' }, failingFetch(429));
    const res = await paidChat(app, { messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'LLM_BUSY' });
  });

  it('does not retry a non-retryable auth failure', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response('denied', { status: 401 });
    }) as unknown as typeof fetch;
    const app = buildApp({ llmApiKey: 'bad-key', routingMaxAttempts: 3 }, fetchImpl);
    const res = await paidChat(app, { messages: [{ role: 'user', content: 'hello' }] });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'LLM_AUTH' });
    expect(calls).toHaveLength(1);
  });
});
