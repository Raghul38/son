/**
 * Tests for the DeepSeek provider adapter.
 *
 * No network is touched: every test injects a fake `fetchImpl` that returns
 * canned Response objects, so the suite is fast and deterministic.
 */
import { callDeepSeek, LlmError, DeepSeekCallOptions } from '../src/llm/deepseek';

function opts(overrides: Partial<DeepSeekCallOptions> = {}): DeepSeekCallOptions {
  return {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'test-key-123',
    timeoutMs: 30000,
    ...overrides,
  };
}

/** Build a Response with a JSON body, like a real provider reply. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const INPUT = {
  modelId: 'deepseek-v3',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('callDeepSeek adapter', () => {
  it('maps deepseek-v3 to deepseek-chat and returns content + usage on success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'deepseek-chat',
        choices: [{ message: { content: 'Hello from DeepSeek!' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      })
    );

    const result = await callDeepSeek(INPUT, opts({ fetchImpl }));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-key-123'
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-chat', // mapped from router-core id "deepseek-v3"
      messages: INPUT.messages,
    });

    expect(result.content).toBe('Hello from DeepSeek!');
    expect(result.model).toBe('deepseek-chat');
    expect(result.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 7,
      total_tokens: 12,
    });
  });

  it('maps 401 from the provider to LLM_AUTH (HTTP 500)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(401, { error: 'bad key' }));

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_AUTH',
      status: 500,
    });
  });

  it('maps 429 from the provider to LLM_BUSY (HTTP 503)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(429, { error: 'slow down' }));

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_BUSY',
      status: 503,
    });
  });

  it('maps provider 5xx to LLM_PROVIDER_ERROR (HTTP 502)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: 'upstream down' }));

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('maps a non-JSON success body to LLM_MALFORMED (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response('this is not json {', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MALFORMED',
      status: 502,
    });
  });

  it('maps a success body missing choices to LLM_MALFORMED (HTTP 502)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_MALFORMED',
      status: 502,
    });
  });

  it('maps a network failure to LLM_PROVIDER_ERROR (HTTP 502)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(callDeepSeek(INPUT, opts({ fetchImpl }))).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      status: 502,
    });
  });

  it('maps a timeout (abort) to LLM_TIMEOUT (HTTP 504)', async () => {
    // A fetch that hangs forever until the injected signal aborts it.
    const fetchImpl = jest.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted'))
          );
        })
    );

    await expect(
      callDeepSeek(INPUT, opts({ fetchImpl, timeoutMs: 25 }))
    ).rejects.toMatchObject({ code: 'LLM_TIMEOUT', status: 504 });
  });

  it('falls back to the raw model id when it is unknown to the mapping', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(200, {
        model: 'deepseek-reasoner',
        choices: [{ message: { content: 'ok' } }],
      })
    );

    await callDeepSeek({ modelId: 'deepseek-reasoner', messages: [] }, opts({ fetchImpl }));
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1].body)).model).toBe(
      'deepseek-reasoner'
    );
  });
});
