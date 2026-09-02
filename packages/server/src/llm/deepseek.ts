/**
 * DeepSeek LLM provider adapter (OpenAI-compatible chat completions).
 *
 * This is the first REAL model provider. It replaces the fake replies from
 * model-stub.ts whenever a routed model's provider is "deepseek" AND the
 * LLM_API_KEY environment variable is set.
 *
 * How it works (beginner summary):
 *   1. The router (router-core) already chose a model id, e.g. "deepseek-v3".
 *   2. We map that id to DeepSeek's real model name, e.g. "deepseek-chat".
 *   3. We POST an OpenAI-compatible /chat/completions request with fetch.
 *   4. We return the reply text plus token usage (for cost tracking later).
 *
 * Errors are mapped to stable machine-readable codes so the chat handler can
 * return clean HTTP responses instead of leaking provider details:
 *   - 401/403 from DeepSeek        -> LLM_AUTH            (HTTP 500: config problem on our side)
 *   - 429 from DeepSeek            -> LLM_BUSY            (HTTP 503)
 *   - 5xx from DeepSeek            -> LLM_PROVIDER_ERROR  (HTTP 502)
 *   - timeout / aborted request    -> LLM_TIMEOUT         (HTTP 504)
 *   - anything else unexpected     -> LLM_MALFORMED       (HTTP 502)
 *
 * No automatic retries in v1 — one-shot chat calls don't need idempotency
 * yet; a bounded retry policy is a deliberate later task.
 *
 * NEVER hardcode the API key here — it always comes from the environment
 * (config.ts reads LLM_API_KEY), and it is never logged.
 */

/** Router-core model id -> DeepSeek's real model name. */
const PROVIDER_MODEL_NAMES: Record<string, string> = {
  'deepseek-v3': 'deepseek-chat',
};

export interface LlmChatInput {
  /** Model id chosen by router-core, e.g. "deepseek-v3". */
  modelId: string;
  /** OpenAI-style chat messages straight from the request body. */
  messages: unknown[];
}

/** Token usage numbers as reported by the provider (for the cost ledger later). */
export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LlmCallResult {
  /** The model's reply text. */
  content: string;
  /** Model name the provider actually used, e.g. "deepseek-chat". */
  model: string;
  /** Token usage, when the provider reports it. */
  usage?: LlmUsage;
}

/** A failed provider call, with a stable code and the HTTP status to return. */
export class LlmError extends Error {
  constructor(
    readonly code:
      | 'LLM_AUTH'
      | 'LLM_BUSY'
      | 'LLM_PROVIDER_ERROR'
      | 'LLM_TIMEOUT'
      | 'LLM_MALFORMED',
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface DeepSeekCallOptions {
  /** DeepSeek API base URL (from LLM_BASE_URL). */
  baseUrl: string;
  /** API key (from LLM_API_KEY) — sent as a Bearer token, never logged. */
  apiKey: string;
  /** Abort the call after this many ms (from LLM_TIMEOUT_MS). */
  timeoutMs: number;
  /**
   * Injectable fetch so tests never touch the network.
   * Defaults to Node's global fetch (Node >= 18 has it built in).
   */
  fetchImpl?: typeof fetch;
}

export async function callDeepSeek(
  input: LlmChatInput,
  opts: DeepSeekCallOptions
): Promise<LlmCallResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const model = PROVIDER_MODEL_NAMES[input.modelId] ?? input.modelId;

  // AbortController + timer = a hard deadline on the provider call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({ model, messages: input.messages }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LlmError(
        'LLM_TIMEOUT',
        `DeepSeek call timed out after ${opts.timeoutMs}ms`,
        504
      );
    }
    throw new LlmError(
      'LLM_PROVIDER_ERROR',
      `DeepSeek call failed: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  } finally {
    clearTimeout(timer);
  }

  // Map provider status codes to our stable error codes.
  if (res.status === 401 || res.status === 403) {
    throw new LlmError(
      'LLM_AUTH',
      'DeepSeek rejected the API key — check LLM_API_KEY',
      500
    );
  }
  if (res.status === 429) {
    throw new LlmError('LLM_BUSY', 'DeepSeek is rate limiting us', 503);
  }
  if (res.status >= 500) {
    throw new LlmError(
      'LLM_PROVIDER_ERROR',
      `DeepSeek server error ${res.status}`,
      502
    );
  }
  if (!res.ok) {
    throw new LlmError(
      'LLM_MALFORMED',
      `DeepSeek returned unexpected status ${res.status}`,
      502
    );
  }

  // Parse the OpenAI-compatible success body.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LlmError('LLM_MALFORMED', 'DeepSeek returned a non-JSON body', 502);
  }

  const choices = (body as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)
    ?.message?.content;

  if (typeof content !== 'string') {
    throw new LlmError(
      'LLM_MALFORMED',
      'DeepSeek response is missing choices[0].message.content',
      502
    );
  }

  const usage = (body as { usage?: Record<string, unknown> })?.usage;
  const usedModel = (body as { model?: unknown })?.model;

  return {
    content,
    model: typeof usedModel === 'string' ? usedModel : model,
    usage: {
      prompt_tokens: asNumber(usage?.prompt_tokens),
      completion_tokens: asNumber(usage?.completion_tokens),
      total_tokens: asNumber(usage?.total_tokens),
    },
  };
}

/** Keep only real numbers (undefined otherwise) so the ledger stays clean. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
