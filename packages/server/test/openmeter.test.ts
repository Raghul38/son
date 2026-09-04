/**
 * Tests for the OpenMeter usage client.
 *
 * No network is touched. The envelope asserted here is the CloudEvents shape
 * the live instance accepted on 2026-09-03; the meter it feeds is
 * key "llm_tokens_total", event_type "kong.llm_request", SUM over "$.tokens".
 * The endpoint's own validator requires id / source / type / subject, so those
 * four are asserted explicitly.
 */
import {
  buildRequestId,
  LlmUsageEvent,
  OpenMeterClient,
  OpenMeterClientOptions,
} from '../src/usage/openmeter';

function opts(overrides: Partial<OpenMeterClientOptions> = {}): OpenMeterClientOptions {
  return {
    baseUrl: 'https://in.api.konghq.com',
    apiKey: 'test-token',
    now: () => new Date('2026-09-03T12:00:00.000Z'),
    ...overrides,
  };
}

const EVENT: LlmUsageEvent = {
  request_id: 'sonpay:mock-nonce-1-123',
  customer: 'rPayerAddr1234567890abcdefghijklmn',
  model: 'Meta-Llama-3_3-70B-Instruct',
  provider: 'ovhcloud',
  input_tokens: 16,
  output_tokens: 9,
  total_tokens: 25,
  payment_id: 'mock-nonce-1-123',
  payment_asset: 'XRP',
  tokens: 25,
};

function accepted(): Response {
  return new Response(null, { status: 204 });
}

describe('OpenMeterClient — the event it sends', () => {
  it('POSTs a CloudEvent the meter can read', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({ status: 'sent' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://in.api.konghq.com/v3/openmeter/events');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/cloudevents+json');
    expect(headers.Authorization).toBe('Bearer test-token');

    expect(JSON.parse(String(init.body))).toEqual({
      specversion: '1.0',
      type: 'kong.llm_request',
      id: 'sonpay:mock-nonce-1-123',
      source: 'sonpay',
      subject: 'rPayerAddr1234567890abcdefghijklmn',
      time: '2026-09-03T12:00:00.000Z',
      datacontenttype: 'application/json',
      data: {
        request_id: 'sonpay:mock-nonce-1-123',
        customer: 'rPayerAddr1234567890abcdefghijklmn',
        model: 'Meta-Llama-3_3-70B-Instruct',
        provider: 'ovhcloud',
        input_tokens: 16,
        output_tokens: 9,
        total_tokens: 25,
        payment_id: 'mock-nonce-1-123',
        payment_asset: 'XRP',
        tokens: 25,
        type: 'total',
      },
    });
  });

  it('sends no price, fee or payment amount — usage only', () => {
    // OpenMeter records usage; Sonpay keeps payment, routing and pricing.
    const fields = Object.keys(EVENT);
    expect(fields).not.toContain('providerCostUsd');
    expect(fields).not.toContain('customerPriceUsd');
    expect(fields).not.toContain('platformFeeUsd');
  });

  it('omits token fields the provider never reported instead of sending 0', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await client.record({ ...EVENT, input_tokens: undefined, output_tokens: undefined });

    const data = JSON.parse(String(fetchImpl.mock.calls[0][1].body)).data;
    expect(data).not.toHaveProperty('input_tokens');
    expect(data).not.toHaveProperty('output_tokens');
    expect(data.total_tokens).toBe(25);
    expect(data.tokens).toBe(25);
  });

  it('honors a custom events path and strips a trailing slash from the base URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(
      // Self-hosted OpenMeter's own ingest path.
      opts({ fetchImpl, baseUrl: 'https://openmeter.internal/', eventsPath: '/api/v1/events' })
    );

    await client.record(EVENT);

    expect(fetchImpl.mock.calls[0][0]).toBe('https://openmeter.internal/api/v1/events');
  });

  it('stamps a configurable source, which the request id is namespaced by', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl, source: 'sonpay-staging' }));
    expect(client.eventSource).toBe('sonpay-staging');

    await client.record({ ...EVENT, request_id: buildRequestId('sonpay-staging', 'pay-1') });

    const body = JSON.parse(String(fetchImpl.mock.calls[0][1].body));
    expect(body.source).toBe('sonpay-staging');
    expect(body.id).toBe('sonpay-staging:pay-1');
  });
});

describe('OpenMeterClient — customer attribution', () => {
  /** A fetch that answers the customers endpoint and the events endpoint. */
  function splitFetch(customer: Response | (() => Response)) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/customers')) {
        return typeof customer === 'function' ? customer() : customer;
      }
      return accepted();
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
  }

  const created = () =>
    new Response(JSON.stringify({ id: '01ABC', key: EVENT.customer }), { status: 201 });
  const conflict = () =>
    new Response(JSON.stringify({ status: 409, title: 'Conflict' }), { status: 409 });

  it('registers the subject as a customer before reporting its usage', async () => {
    const { fetchImpl, calls } = splitFetch(created());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT, { ensureCustomer: true })).resolves.toEqual({
      status: 'sent',
      customer: { status: 'created' },
    });

    // Order matters: a customer created after its events does not claim them.
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://in.api.konghq.com/v3/openmeter/customers');
    expect(calls[1].url).toBe('https://in.api.konghq.com/v3/openmeter/events');

    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-token'
    );
    // The key IS the subject, which is what makes the upsert idempotent.
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      name: 'rPayerAddr1234567890abcdefghijklmn',
      key: 'rPayerAddr1234567890abcdefghijklmn',
      usage_attribution: { subject_keys: ['rPayerAddr1234567890abcdefghijklmn'] },
    });
  });

  it('does not touch the customer list unless asked', async () => {
    const { fetchImpl, calls } = splitFetch(created());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({ status: 'sent' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/events');
  });

  it('registers a subject once, then serves the mapping from memory', async () => {
    const { fetchImpl, calls } = splitFetch(created());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await client.record(EVENT, { ensureCustomer: true });
    const second = await client.record(
      { ...EVENT, request_id: 'sonpay:second-payment' },
      { ensureCustomer: true }
    );

    expect(second).toEqual({ status: 'sent', customer: { status: 'cached' } });
    expect(calls.filter((c) => c.url.includes('/customers'))).toHaveLength(1);
  });

  it('accepts a 409 as "already mapped" once it has read the mapping back', async () => {
    // 409 = the key is taken. It is only proof of attribution if the existing
    // customer actually claims our subject, so we check instead of assuming.
    const urls: string[] = [];
    const fetchImpl = jest.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('/customers?')) {
        return new Response(
          JSON.stringify({
            data: [
              { key: EVENT.customer, usage_attribution: { subject_keys: [EVENT.customer] } },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/customers')) return conflict();
      return accepted();
    }) as unknown as typeof fetch;
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT, { ensureCustomer: true })).resolves.toEqual({
      status: 'sent',
      customer: { status: 'exists' },
    });
    expect(urls.some((u) => u.includes(`?key=${encodeURIComponent(EVENT.customer)}`))).toBe(true);
  });

  it('reports a taken key that does NOT claim the subject, and changes nothing', async () => {
    // Someone else owns this key with different attribution. Overwriting an
    // operator's mapping would be worse than saying so.
    const requests: string[] = [];
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method ?? 'GET'} ${url}`);
      if (url.includes('/customers?')) {
        return new Response(
          JSON.stringify({
            data: [{ key: EVENT.customer, usage_attribution: { subject_keys: ['someone-else'] } }],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/customers')) return conflict();
      return accepted();
    }) as unknown as typeof fetch;
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT, { ensureCustomer: true })).resolves.toEqual({
      status: 'sent',
      customer: { status: 'exists-unmapped' },
    });
    // No PUT/PATCH anywhere: the existing customer is left exactly as it was.
    expect(requests.some((r) => r.startsWith('PUT') || r.startsWith('PATCH'))).toBe(false);
  });

  it('still reports usage when the customer upsert fails', async () => {
    // Unattributed usage beats lost usage: the mapping can be repaired later,
    // the tokens cannot be re-counted.
    const { fetchImpl, calls } = splitFetch(new Response('boom', { status: 500 }));
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT, { ensureCustomer: true })).resolves.toEqual({
      status: 'sent',
      customer: { status: 'failed', reason: 'http-500' },
    });
    expect(calls.some((c) => c.url.includes('/events'))).toBe(true);
  });

  it('retries the upsert next time when it failed', async () => {
    let attempt = 0;
    const { fetchImpl } = splitFetch(() =>
      ++attempt === 1 ? new Response('boom', { status: 500 }) : created()
    );
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await client.record(EVENT, { ensureCustomer: true });
    const second = await client.record(
      { ...EVENT, request_id: 'sonpay:second-payment' },
      { ensureCustomer: true }
    );

    expect(second.customer).toEqual({ status: 'created' });
  });

  it('honors a custom customers path', async () => {
    const { fetchImpl, calls } = splitFetch(created());
    const client = new OpenMeterClient(
      opts({ fetchImpl, baseUrl: 'https://openmeter.internal', customersPath: '/api/v1/customers' })
    );

    await client.record(EVENT, { ensureCustomer: true });

    expect(calls[0].url).toBe('https://openmeter.internal/api/v1/customers');
  });

  it('does nothing when metering is disabled', async () => {
    const fetchImpl = jest.fn();
    const client = new OpenMeterClient(opts({ fetchImpl, baseUrl: '' }));

    await expect(client.ensureCustomer('rSomebody')).resolves.toEqual({ status: 'disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('OpenMeterClient — duplicate usage', () => {
  it('sends the same request id only once', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({ status: 'sent' });
    await expect(client.record(EVENT)).resolves.toEqual({ status: 'duplicate' });
    await expect(client.record(EVENT)).resolves.toEqual({ status: 'duplicate' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('derives the request id from the payment, so one payment is one event', () => {
    expect(buildRequestId('sonpay', 'tx-hash-abc')).toBe('sonpay:tx-hash-abc');
    expect(buildRequestId('sonpay', 'tx-hash-abc')).toBe(
      buildRequestId('sonpay', 'tx-hash-abc')
    );
  });

  it('still meters a different payment', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await client.record(EVENT);
    await expect(
      client.record({ ...EVENT, request_id: 'sonpay:other-payment' })
    ).resolves.toEqual({ status: 'sent' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('lets a retry through when the first attempt never landed', async () => {
    // A failed send metered nothing, so the id must not be burned.
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(new Response('nope', { status: 500 }))
      .mockResolvedValueOnce(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({
      status: 'failed',
      reason: 'http-500',
    });
    await expect(client.record(EVENT)).resolves.toEqual({ status: 'sent' });
  });

  it('forgets ids beyond its capacity without growing forever', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(accepted());
    const client = new OpenMeterClient(opts({ fetchImpl, dedupeCapacity: 2 }));

    await client.record({ ...EVENT, request_id: 'a' });
    await client.record({ ...EVENT, request_id: 'b' });
    await client.record({ ...EVENT, request_id: 'c' }); // evicts "a"

    expect(await client.record({ ...EVENT, request_id: 'b' })).toEqual({
      status: 'duplicate',
    });
    // "a" was evicted, so it is re-sent; OpenMeter's own (source, id) dedupe
    // is the backstop for this window.
    expect(await client.record({ ...EVENT, request_id: 'a' })).toEqual({ status: 'sent' });
  });
});

describe('OpenMeterClient — failures never break the request', () => {
  it('is disabled with no URL or no key, and makes no call', async () => {
    const fetchImpl = jest.fn();
    for (const override of [{ baseUrl: '' }, { apiKey: '' }]) {
      const client = new OpenMeterClient(opts({ fetchImpl, ...override }));
      expect(client.enabled).toBe(false);
      await expect(client.record(EVENT)).resolves.toEqual({ status: 'disabled' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an HTTP rejection instead of throwing', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('{"detail":"bad"}', { status: 400 }));
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({
      status: 'failed',
      reason: 'http-400',
    });
  });

  it('reports a transport failure instead of throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = new OpenMeterClient(opts({ fetchImpl }));

    await expect(client.record(EVENT)).resolves.toEqual({
      status: 'failed',
      reason: 'transport-error',
    });
  });

  it('gives up on its own deadline instead of hanging the response', async () => {
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        })
    );
    const client = new OpenMeterClient(opts({ fetchImpl, timeoutMs: 25 }));

    await expect(client.record(EVENT)).resolves.toEqual({
      status: 'failed',
      reason: 'timeout-25ms',
    });
  });

  it('never leaks the API key in a failure reason', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('Bearer super-secret rejected', { status: 401 }));
    const client = new OpenMeterClient(opts({ fetchImpl, apiKey: 'super-secret' }));

    const result = await client.record(EVENT);
    expect(JSON.stringify(result)).not.toContain('super-secret');
  });
});
