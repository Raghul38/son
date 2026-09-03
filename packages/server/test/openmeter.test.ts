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
