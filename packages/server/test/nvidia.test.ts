/**
 * Tests for the NVIDIA NIM provider adapter.
 *
 * No network is touched: every test injects a fake `fetchImpl` that returns
 * canned Response objects. The canned bodies and status codes mirror what the
 * live endpoint actually returned when the adapter was written (see the header
 * of src/llm/nvidia.ts) — in particular the 403 "Authorization failed" shape
 * and the 410 Gone answer for a model past its end-of-life date.
 */
import { callNvidia, NvidiaCallOptions, NVIDIA_DEFAULT_BASE_URL } from '../src/llm/nvidia';

function opts(overrides: Partial<NvidiaCallOptions> = {}): NvidiaCallOptions {
  return {
    baseUrl: NVIDIA_DEFAULT_BASE_URL,
    apiKey: 'nvapi-test-key',
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
  modelId: 'nvidia/llama-3.1-nemotron-70b-instruct',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('callNvidia adapter', () => {
  it('posts to the hosted NIM endpoint with a Bearer key and returns content + usage', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        choices: [{ message: { role: 'assistant', content: 'Hello from NIM!' } }],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      })
    );

    const result = await callNvidia(INPUT, opts({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer nvapi-test-key'
    );
    // NVIDIA's catalog ids are used verbatim — no name mapping to get wrong.
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'nvidia/llama-3.1-nemotron-70b-instruct',
      messages: INPUT.messages,
    });

    expect(result.content).toBe('Hello from NIM!');
    expect(result.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct');
    expect(result.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 4,
      total_tokens: 15,
    });
  });

  it('honors a custom base URL and strips a trailing slash', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, { choices: [{ message: { content: 'ok' } }] })
    );

    await callNvidia(INPUT, opts({ fetchImpl, baseUrl: 'https://nim.internal/v1/' }));

    expect(fetchImpl.mock.calls[0][0]).toBe('https://nim.internal/v1/chat/completions');
  });

  it('maps 403 "Authorization failed" to LLM_AUTH (HTTP 500), naming NVIDIA_API_KEY', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(403, { status: 403, title: 'Forbidden', detail: 'Authorization failed' })
    );

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_AUTH',
      status: 500,
      message: expect.stringContaining('NVIDIA_API_KEY'),
    });
  });

  it('maps 401 (missing Authorization header) to LLM_AUTH (HTTP 500)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(401, { detail: "Header of type 'authorization' was missing" })
    );

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_AUTH',
      status: 500,
    });
  });

  it('maps 410 Gone (model end-of-life) to LLM_MODEL_UNAVAILABLE (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('Model reached its end of life on 2026-08-26', { status: 410 })
    );

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MODEL_UNAVAILABLE',
      status: 502,
    });
  });

  it('maps 404 (unknown model) to LLM_MODEL_UNAVAILABLE (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(404, { detail: 'Not Found' }));

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MODEL_UNAVAILABLE',
      status: 502,
    });
  });

  it('maps 429 to LLM_BUSY (HTTP 503)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(429, { detail: 'slow down' }));

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_BUSY',
      status: 503,
    });
  });

  it('maps 5xx to LLM_PROVIDER_ERROR (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(503, { detail: 'busy' }));

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('maps a malformed success body to LLM_MALFORMED (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      // 200 OK, but the completion carries no text content.
      jsonResponse(200, { model: 'x', choices: [{ message: { role: 'assistant' } }] })
    );

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MALFORMED',
      status: 502,
    });
  });

  it('maps a non-JSON success body to LLM_MALFORMED (HTTP 502)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));

    await expect(callNvidia(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
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
      callNvidia(INPUT, opts({ fetchImpl, timeoutMs: 25 }))
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT', status: 504 });
  });

  it('normalizes partial / non-numeric usage instead of passing junk on', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 9, completion_tokens: 'lots', total_tokens: null },
      })
    );

    const result = await callNvidia(INPUT, opts({ fetchImpl }));

    expect(result.usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: undefined,
      total_tokens: undefined,
    });
  });

  it('omits usage numbers entirely when the provider reports none', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: 'ok' } }] }));

    const result = await callNvidia(INPUT, opts({ fetchImpl }));

    expect(result.usage).toEqual({
      prompt_tokens: undefined,
      completion_tokens: undefined,
      total_tokens: undefined,
    });
  });
});
