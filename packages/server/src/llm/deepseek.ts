/**
 * DeepSeek LLM provider adapter (OpenAI-compatible chat completions).
 *
 * This was the first REAL model provider. It replaces the fake replies from
 * model-stub.ts whenever a routed model's provider is "deepseek" AND the
 * LLM_API_KEY environment variable is set.
 *
 * How it works (beginner summary):
 *   1. The router (router-core) already chose a model id, e.g. "deepseek-v3".
 *   2. We map that id to DeepSeek's real model name, e.g. "deepseek-chat".
 *   3. We POST an OpenAI-compatible /chat/completions request with fetch.
 *   4. We return the reply text plus token usage (for cost tracking later).
 *
 * Steps 3 and 4 — plus the deadline and the status -> error-code mapping —
 * are shared with the other OpenAI-compatible providers and live in
 * provider.ts. The types below are re-exported so existing importers of this
 * module keep working unchanged.
 *
 * Endpoint:  ${LLM_BASE_URL}/chat/completions  (default https://api.deepseek.com)
 * Auth:      Authorization: Bearer ${LLM_API_KEY}
 *
 * NEVER hardcode the API key here — it always comes from the environment
 * (config.ts reads LLM_API_KEY), and it is never logged.
 */
import {
  callOpenAICompatible,
  LlmCallResult,
  LlmChatInput,
} from './provider';

export {
  LlmError,
  type LlmCallResult,
  type LlmChatInput,
  type LlmErrorCode,
  type LlmUsage,
} from './provider';

/** Router-core model id -> DeepSeek's real model name. */
const PROVIDER_MODEL_NAMES: Record<string, string> = {
  'deepseek-v3': 'deepseek-chat',
};

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
  return callOpenAICompatible(input, {
    label: 'DeepSeek',
    keyEnvVar: 'LLM_API_KEY',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs,
    modelNames: PROVIDER_MODEL_NAMES,
    fetchImpl: opts.fetchImpl,
  });
}
