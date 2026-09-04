/**
 * Multi-provider selection and the real fallback chain, end to end over HTTP.
 *
 * Every request goes through the real x402 handshake (MockFacilitator), so
 * these tests also prove provider dispatch still happens strictly AFTER
 * payment verification. No network: a single injected fetch answers for all
 * three providers, dispatching on the URL, which is also how each test proves
 * *which* provider was actually called.
 *
 * On chain order: router-core ranks by published price, and NVIDIA publishes
 * no per-token price for its hosted endpoints, so NVIDIA models deliberately
 * rank last (see models.ts). The realistic chain with everything configured is
 * therefore deepseek -> ovhcloud -> nvidia.
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
  // Every test here is about real providers, so never let an unconfigured
  // provider win the route and answer with the stub.
  routingSkipUnconfiguredProviders: true,
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

const HELLO = { messages: [{ role: 'user', content: 'hello' }] };

/** Which provider a request URL belongs to. */
function providerOf(url: string): 'deepseek' | 'nvidia' | 'ovhcloud' | 'unknown' {
  if (url.includes('api.deepseek.com')) return 'deepseek';
  if (url.includes('integrate.api.nvidia.com')) return 'nvidia';
  if (url.includes('oai.endpoints')) return 'ovhcloud';
  return 'unknown';
}

type Reply = Response | ((init?: RequestInit) => Response | Promise<Response>);

/** A canned OpenAI-compatible 200 with usage numbers. */
function completion(content: string, model = 'served-model'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * A fetch that answers per provider. Each provider may map to a Response, or
 * to a queue of Responses when a test needs the same provider to be called
 * more than once. Records every (provider, url, headers) it saw.
 */
function routerFetch(replies: Partial<Record<string, Reply | Reply[]>>) {
  const calls: { provider: string; url: string; headers: Record<string, string> }[] = [];
  const queues = new Map<string, Reply[]>(
    Object.entries(replies).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v as Reply]])
  );

  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const provider = providerOf(String(url));
    calls.push({
      provider,
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const queue = queues.get(provider);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`unexpected call to ${provider} (${url})`);
    }
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return typeof next === 'function' ? next(init) : next;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('provider selection', () => {
  it('routes to NVIDIA when it is the only configured provider', async () => {
    const { fetchImpl, calls } = routerFetch({ nvidia: () => completion('from NIM') });
    const res = await paidChat(buildApp({ nvidiaApiKey: 'nvapi-test' }, fetchImpl), HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('nvidia');
    expect(res.body.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct');
    expect(res.body.content).toBe('from NIM');
    expect(res.body.stub).toBeUndefined();
    // No published price -> the response carries no cost claim either.
    expect(res.body.costPer1MTokens).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(calls[0].headers.Authorization).toBe('Bearer nvapi-test');
  });

  it('routes to OVHcloud on its anonymous free tier, with no Authorization header', async () => {
    const { fetchImpl, calls } = routerFetch({ ovhcloud: () => completion('from OVH') });
    const res = await paidChat(buildApp({ ovhAllowAnonymous: true }, fetchImpl), HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('ovhcloud');
    expect(res.body.model).toBe('Qwen3.5-397B-A17B'); // cheapest OVHcloud chat model
    expect(res.body.costPer1MTokens).toBe(0.71);
    expect(calls[0].url).toBe(
      'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'
    );
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('prefers the cheapest published price over an unpriced model', async () => {
    const { fetchImpl } = routerFetch({ deepseek: () => completion('from DeepSeek') });
    const app = buildApp(
      { llmApiKey: 'ds-key', nvidiaApiKey: 'nvapi-test', ovhApiKey: 'ovh-token' },
      fetchImpl
    );
    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('deepseek');
    // Cost-ranked, with the unpriced NVIDIA models pinned to the end.
    expect(res.body.routing.chain).toEqual([
      'deepseek-v3',
      'Qwen3.5-397B-A17B',
      'Meta-Llama-3_3-70B-Instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'meta/llama-3.2-11b-vision-instruct',
    ]);
  });

  it('normalizes token usage from whichever provider answered', async () => {
    const { fetchImpl } = routerFetch({ ovhcloud: () => completion('hi') });
    const res = await paidChat(buildApp({ ovhApiKey: 'ovh-token' }, fetchImpl), HELLO);

    expect(res.body.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    });
  });
});

describe('provider unavailable', () => {
  it('refuses to route when no provider has credentials', async () => {
    const res = await paidChat(buildApp(), HELLO);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE', reason: 'no-available-provider' });
  });

  it('treats OVHcloud as unavailable when anonymous use was not opted into', async () => {
    // A base URL alone is not credentials, and the free tier is opt-in.
    const res = await paidChat(buildApp({ ovhAllowAnonymous: false }), HELLO);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE', reason: 'no-available-provider' });
  });

  it('will not serve an unpriced model to a request that set a cost ceiling', async () => {
    // NVIDIA is the only provider with credentials, but its models carry no
    // published price, so a generous ceiling still drops them; the priced
    // models that survive the ceiling belong to providers we cannot call.
    // Either way the caller's spend guarantee is honored instead of ignored.
    const res = await paidChat(buildApp({ nvidiaApiKey: 'nvapi-test' }), {
      ...HELLO,
      maxCostPer1MTokens: 5,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'NO_ROUTE', reason: 'no-available-provider' });
  });
});

describe('cross-provider fallback', () => {
  it('DeepSeek unavailable -> NVIDIA answers', async () => {
    const { fetchImpl, calls } = routerFetch({
      deepseek: () => new Response('upstream down', { status: 503 }),
      nvidia: () => completion('from NIM'),
    });
    const app = buildApp({ llmApiKey: 'ds-key', nvidiaApiKey: 'nvapi-test' }, fetchImpl);

    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('nvidia');
    expect(res.body.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct');
    expect(res.body.content).toBe('from NIM');
    expect(res.body.routing.attempts).toBe(2);
    expect(calls.map((c) => c.provider)).toEqual(['deepseek', 'nvidia']);
  });

  it('OVHcloud unavailable -> NVIDIA answers', async () => {
    const { fetchImpl, calls } = routerFetch({
      ovhcloud: () => new Response('{"message":"API rate limit exceeded"}', { status: 429 }),
      nvidia: () => completion('from NIM'),
    });
    const app = buildApp(
      { ovhAllowAnonymous: true, nvidiaApiKey: 'nvapi-test', routingMaxAttempts: 3 },
      fetchImpl
    );

    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('nvidia');
    expect(res.body.routing.attempts).toBe(3);
    // Both OVHcloud models were rate limited before NVIDIA was tried.
    expect(calls.map((c) => c.provider)).toEqual(['ovhcloud', 'ovhcloud', 'nvidia']);
  });

  it('a retired NVIDIA model (410 Gone) advances the chain instead of failing', async () => {
    const { fetchImpl, calls } = routerFetch({
      nvidia: [
        new Response('Model reached its end of life on 2026-08-26', { status: 410 }),
        completion('from the surviving model'),
      ],
    });
    const res = await paidChat(buildApp({ nvidiaApiKey: 'nvapi-test' }, fetchImpl), HELLO);

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('meta/llama-3.2-11b-vision-instruct');
    expect(res.body.routing.attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  it('stops at the attempt budget and returns the last provider error', async () => {
    const { fetchImpl, calls } = routerFetch({
      deepseek: () => new Response('down', { status: 500 }),
      nvidia: () => new Response('down', { status: 503 }),
    });
    const app = buildApp({ llmApiKey: 'ds-key', nvidiaApiKey: 'nvapi-test' }, fetchImpl);

    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'LLM_PROVIDER_ERROR' });
    expect(res.body.stub).toBeUndefined(); // never downgrade a paid call to a stub
    expect(calls).toHaveLength(2); // ROUTING_MAX_ATTEMPTS default
  });

  it('does not fall back across providers on a non-retryable auth failure', async () => {
    const { fetchImpl, calls } = routerFetch({
      deepseek: () => new Response('denied', { status: 401 }),
      nvidia: () => completion('should never be reached'),
    });
    const app = buildApp({ llmApiKey: 'bad-key', nvidiaApiKey: 'nvapi-test' }, fetchImpl);

    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'LLM_AUTH' });
    expect(calls.map((c) => c.provider)).toEqual(['deepseek']);
  });

  it('does not fall back when a provider returns a malformed body', async () => {
    const { fetchImpl, calls } = routerFetch({
      deepseek: () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      nvidia: () => completion('should never be reached'),
    });
    const app = buildApp({ llmApiKey: 'ds-key', nvidiaApiKey: 'nvapi-test' }, fetchImpl);

    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'LLM_MALFORMED' });
    expect(calls.map((c) => c.provider)).toEqual(['deepseek']);
  });

  it('a provider timeout advances the chain', async () => {
    // A fetch that hangs until the adapter's own deadline aborts it.
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted'))
        );
      });
    const { fetchImpl, calls } = routerFetch({
      deepseek: hang,
      nvidia: () => completion('from NIM'),
    });

    const app = buildApp(
      { llmApiKey: 'ds-key', nvidiaApiKey: 'nvapi-test', llmTimeoutMs: 25 },
      fetchImpl
    );
    const res = await paidChat(app, HELLO);

    expect(res.status).toBe(200);
    expect(res.body.modelProvider).toBe('nvidia');
    expect(res.body.routing.attempts).toBe(2);
    expect(calls.map((c) => c.provider)).toEqual(['deepseek', 'nvidia']);
  });
});
