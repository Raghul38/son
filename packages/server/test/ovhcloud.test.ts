/**
 * Tests for the OVHcloud AI Endpoints provider adapter (the free/low-cost one).
 *
 * No network is touched. The success body below is the *actual* shape returned
 * by an anonymous live call to Mistral-7B-Instruct-v0.3 on 2026-09-03, down to
 * the empty `tool_calls` array and the usage numbers — see the header of
 * src/llm/ovhcloud.ts.
 */
import {
  callOvhcloud,
  OvhcloudCallOptions,
  OVHCLOUD_DEFAULT_BASE_URL,
} from '../src/llm/ovhcloud';

function opts(overrides: Partial<OvhcloudCallOptions> = {}): OvhcloudCallOptions {
  return {
    baseUrl: OVHCLOUD_DEFAULT_BASE_URL,
    apiKey: 'ovh-test-token',
    timeoutMs: 30000,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const INPUT = {
  modelId: 'Meta-Llama-3_3-70B-Instruct',
  messages: [{ role: 'user', content: 'hi' }],
};

/** The verbatim shape of a real anonymous AI Endpoints reply. */
const LIVE_SHAPED_BODY = {
  id: 'chatcmpl-0cd801fb66704047a8b7ed9bbbd9c7aa',
  choices: [
    { index: 0, message: { role: 'assistant', content: ' OVH_ANON_OK', tool_calls: [] }, finish_reason: 'stop' },
  ],
  created: 1788467107,
  model: 'Meta-Llama-3_3-70B-Instruct',
  object: 'chat.completion',
  usage: { prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 },
};

describe('callOvhcloud adapter', () => {
  it('posts to AI Endpoints with a Bearer token and returns content + usage', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, LIVE_SHAPED_BODY));

    const result = await callOvhcloud(INPUT, opts({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions'
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer ovh-test-token'
    );
    // OVHcloud's catalog ids are used verbatim — no name mapping.
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'Meta-Llama-3_3-70B-Instruct',
      messages: INPUT.messages,
    });

    expect(result.content).toBe(' OVH_ANON_OK');
    expect(result.model).toBe('Meta-Llama-3_3-70B-Instruct');
    expect(result.usage).toEqual({
      prompt_tokens: 16,
      completion_tokens: 9,
      total_tokens: 25,
    });
  });

  it('sends NO Authorization header on the anonymous free tier', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, LIVE_SHAPED_BODY));

    await callOvhcloud(INPUT, opts({ fetchImpl, apiKey: '' }));

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('maps the anonymous tier\'s 2-rpm 429 to LLM_BUSY (HTTP 503)', async () => {
    // Verbatim body observed when the 2 req/min/IP anonymous cap is hit.
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(429, { message: 'API rate limit exceeded', request_id: 'a7a32a4e' })
    );

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_BUSY',
      status: 503,
    });
  });

  it('maps 403 (revoked/Discovery-mode token) to LLM_AUTH, naming the env var', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(403, { message: 'Authentication Failed' }));

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_AUTH',
      status: 500,
      message: expect.stringContaining('OVH_AI_ENDPOINTS_ACCESS_TOKEN'),
    });
  });

  it('maps 404 (model retired from the catalog) to LLM_MODEL_UNAVAILABLE', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(404, { message: 'not found' }));

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MODEL_UNAVAILABLE',
      status: 502,
    });
  });

  it('maps 5xx to LLM_PROVIDER_ERROR (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(502, { message: 'upstream' }));

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('maps a malformed success body to LLM_MALFORMED (HTTP 502)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [] }));

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MALFORMED',
      status: 502,
    });
  });

  it('maps a timeout (abort) to LLM_TIMEOUT (HTTP 504)', async () => {
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        })
    );

    await expect(
      callOvhcloud(INPUT, opts({ fetchImpl, timeoutMs: 25 }))
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT', status: 504 });
  });

  it('maps a transport failure to LLM_PROVIDER_ERROR (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNRESET'));

    await expect(callOvhcloud(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('normalizes a usage object with missing / non-numeric fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: '16', completion_tokens: 9 },
      })
    );

    const result = await callOvhcloud(INPUT, opts({ fetchImpl }));

    expect(result.usage).toEqual({
      prompt_tokens: undefined, // "16" is a string, not a token count
      completion_tokens: 9,
      total_tokens: undefined,
    });
  });
});
