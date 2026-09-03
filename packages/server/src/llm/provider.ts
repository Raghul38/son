/**
 * The provider interface shared by every real LLM adapter.
 *
 * All three providers we call today (DeepSeek, NVIDIA NIM, OVHcloud AI
 * Endpoints) speak the same OpenAI-compatible `/chat/completions` dialect, so
 * the transport, the deadline and the status -> error-code mapping live here
 * once and each adapter only supplies its endpoint, credentials and model-name
 * mapping. Adding a fourth OpenAI-compatible provider should be ~20 lines.
 *
 * Error codes are stable and machine-readable so the chat handler can decide
 * whether to fail the request or fall back to the next model in the routing
 * chain without ever inspecting provider-specific payloads:
 *
 *   401 / 403                  -> LLM_AUTH               (HTTP 500) not retryable
 *   404 / 410                  -> LLM_MODEL_UNAVAILABLE  (HTTP 502) retryable
 *   429                        -> LLM_BUSY               (HTTP 503) retryable
 *   5xx                        -> LLM_PROVIDER_ERROR     (HTTP 502) retryable
 *   timeout / transport error  -> LLM_TIMEOUT / LLM_PROVIDER_ERROR
 *   anything else / bad body   -> LLM_MALFORMED          (HTTP 502) not retryable
 *
 * LLM_MODEL_UNAVAILABLE exists because hosted catalogs retire models: NVIDIA
 * answers `410 Gone` for a model past its end-of-life date (observed for
 * meta/llama-3.1-8b-instruct, EOL 2026-08-26). That is a per-model condition,
 * not a per-request one, so the router should move on to the next candidate
 * instead of failing the paid request.
 *
 * NEVER hardcode an API key in an adapter — keys always come from the
 * environment via config.ts, and they are never logged.
 */

/** Stable, machine-readable provider failure codes. */
export type LlmErrorCode =
  | 'LLM_AUTH'
  | 'LLM_BUSY'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_MALFORMED'
  | 'LLM_MODEL_UNAVAILABLE';

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
    readonly code: LlmErrorCode,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** One provider call: adapters bind these and hand the result back to chat.ts. */
export type ProviderCall = (
  input: LlmChatInput,
  fetchImpl?: typeof fetch
) => Promise<LlmCallResult>;

export interface OpenAICompatibleOptions {
  /** Human-readable provider name used in error messages, e.g. "NVIDIA NIM". */
  label: string;
  /** Env var that holds this provider's key — named in LLM_AUTH messages. */
  keyEnvVar: string;
  /** Base URL; "/chat/completions" is appended. */
  baseUrl: string;
  /**
   * API key, sent as a Bearer token and never logged. An empty string sends no
   * Authorization header at all, which is what OVHcloud's anonymous free tier
   * expects (see ovhcloud.ts).
   */
  apiKey: string;
  /** Abort the call after this many ms. */
  timeoutMs: number;
  /** Router-core model id -> the provider's own model name, when they differ. */
  modelNames?: Readonly<Record<string, string>>;
  /**
   * Injectable fetch so tests never touch the network.
   * Defaults to Node's global fetch (Node >= 18 has it built in).
   */
  fetchImpl?: typeof fetch;
}

/**
 * POST an OpenAI-compatible chat completion and normalize the answer.
 *
 * No automatic retries here: retrying is the router's job (it retries with the
 * *next model*, which is the useful kind of retry for a fallback chain).
 */
export async function callOpenAICompatible(
  input: LlmChatInput,
  opts: OpenAICompatibleOptions
): Promise<LlmCallResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const model = opts.modelNames?.[input.modelId] ?? input.modelId;

  // AbortController + timer = a hard deadline on the provider call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey !== '' && { Authorization: `Bearer ${opts.apiKey}` }),
      },
      body: JSON.stringify({ model, messages: input.messages }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new LlmError(
        'LLM_TIMEOUT',
        `${opts.label} call timed out after ${opts.timeoutMs}ms`,
        504
      );
    }
    throw new LlmError(
      'LLM_PROVIDER_ERROR',
      `${opts.label} call failed: ${err instanceof Error ? err.message : String(err)}`,
      502
    );
  } finally {
    clearTimeout(timer);
  }

  // Map provider status codes to our stable error codes.
  if (res.status === 401 || res.status === 403) {
    throw new LlmError(
      'LLM_AUTH',
      `${opts.label} rejected the API key — check ${opts.keyEnvVar}`,
      500
    );
  }
  if (res.status === 404 || res.status === 410) {
    throw new LlmError(
      'LLM_MODEL_UNAVAILABLE',
      `${opts.label} no longer serves model "${model}" (HTTP ${res.status})`,
      502
    );
  }
  if (res.status === 429) {
    throw new LlmError('LLM_BUSY', `${opts.label} is rate limiting us`, 503);
  }
  if (res.status >= 500) {
    throw new LlmError('LLM_PROVIDER_ERROR', `${opts.label} server error ${res.status}`, 502);
  }
  if (!res.ok) {
    throw new LlmError(
      'LLM_MALFORMED',
      `${opts.label} returned unexpected status ${res.status}`,
      502
    );
  }

  // Parse the OpenAI-compatible success body.
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LlmError('LLM_MALFORMED', `${opts.label} returned a non-JSON body`, 502);
  }

  const choices = (body as { choices?: unknown })?.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;

  if (typeof content !== 'string') {
    throw new LlmError(
      'LLM_MALFORMED',
      `${opts.label} response is missing choices[0].message.content`,
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
