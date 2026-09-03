/**
 * NVIDIA NIM provider adapter (hosted build.nvidia.com endpoints).
 *
 * Everything below was checked against the live API on 2026-09-02, not from
 * memory — NVIDIA retires models on published EOL dates, so model ids must
 * come from the catalog rather than from a blog post.
 *
 *   Endpoint  POST ${NVIDIA_BASE_URL}/chat/completions
 *             default NVIDIA_BASE_URL = https://integrate.api.nvidia.com/v1
 *   Catalog   GET  https://integrate.api.nvidia.com/v1/models
 *             public, needs no key; returned 81 models when this was written.
 *   Auth      Authorization: Bearer ${NVIDIA_API_KEY}   (keys look like nvapi-…)
 *   Format    OpenAI-compatible: choices[0].message.content plus a
 *             usage { prompt_tokens, completion_tokens, total_tokens } object.
 *
 * Observed status codes (all reproduced against the live endpoint):
 *   - no Authorization header -> 401 "Header of type 'authorization' was missing"
 *   - wrong key               -> 403 {"status":403,"title":"Forbidden",...}
 *   - retired model           -> 410 Gone ("reached its end of life on …")
 * The 410 is why provider.ts has LLM_MODEL_UNAVAILABLE: a retired model must
 * advance the routing chain instead of failing a paid request.
 *
 * Model ids are NVIDIA's own catalog ids (e.g.
 * "nvidia/llama-3.1-nemotron-70b-instruct"), so router-core's ids are sent
 * through unchanged and no name mapping is needed.
 *
 * PRICING / TERMS — read before enabling this in production:
 * NVIDIA publishes no per-token price for the hosted endpoints. The developer
 * tier is free and rate-limited, and NVIDIA's own FAQ defines production use
 * (anything beyond development, testing, research or evaluation) as requiring
 * NVIDIA AI Enterprise. router-core therefore records these models with an
 * *unknown* cost, which sorts them last and keeps them out of any request that
 * sets a cost ceiling. See packages/router-core/src/models.ts.
 */
import { callOpenAICompatible, LlmCallResult, LlmChatInput } from './provider';

/** Default hosted NIM base URL; overridable with NVIDIA_BASE_URL. */
export const NVIDIA_DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';

export interface NvidiaCallOptions {
  /** NIM base URL (from NVIDIA_BASE_URL). */
  baseUrl: string;
  /** API key (from NVIDIA_API_KEY) — sent as a Bearer token, never logged. */
  apiKey: string;
  /** Abort the call after this many ms (from LLM_TIMEOUT_MS). */
  timeoutMs: number;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export async function callNvidia(
  input: LlmChatInput,
  opts: NvidiaCallOptions
): Promise<LlmCallResult> {
  return callOpenAICompatible(input, {
    label: 'NVIDIA NIM',
    keyEnvVar: 'NVIDIA_API_KEY',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}
