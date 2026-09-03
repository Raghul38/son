/**
 * OVHcloud AI Endpoints provider adapter — the verified free/low-cost provider.
 *
 * Chosen because every claim below could be verified from the outside, with no
 * account: the catalog is public AND an anonymous chat completion actually
 * returns a real answer. Verified live on 2026-09-03:
 *
 *   Endpoint  POST ${OVH_AI_ENDPOINTS_BASE_URL}/chat/completions
 *             default = https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
 *   Catalog   GET  https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models
 *             public, no key; 25 models, each with `pricing` in USD *per token*
 *             and `context_length` / `max_completion_tokens`.
 *   Auth      Authorization: Bearer ${OVH_AI_ENDPOINTS_ACCESS_TOKEN}
 *             …or NO Authorization header at all for the anonymous free tier.
 *   Format    OpenAI-compatible. A real anonymous call to
 *             Mistral-7B-Instruct-v0.3 returned choices[0].message.content plus
 *             usage {prompt_tokens: 16, completion_tokens: 9, total_tokens: 25}.
 *
 * FREE TIER (per OVHcloud's "AI Endpoints - Getting started" guide):
 *   - anonymous:     2 requests per minute, per IP and per model — no key, no
 *                    account, no card. Over the limit returns HTTP 429.
 *   - with a key:    400 requests per minute, per Public Cloud project and per
 *                    model. Requires a payment method on the project; keys from
 *                    projects in Discovery mode cannot use the service.
 * The anonymous tier is a genuine free tier (it was exercised, not assumed),
 * but 2 rpm makes it a development/failover convenience rather than a
 * production path — which is why it is opt-in via
 * OVH_AI_ENDPOINTS_ALLOW_ANONYMOUS instead of being on by default.
 *
 * Model ids are OVHcloud's own catalog ids (e.g. "Meta-Llama-3_3-70B-Instruct")
 * so router-core's ids pass through unchanged; per-model prices in
 * packages/router-core/src/models.ts are the catalog's own numbers.
 */
import { callOpenAICompatible, LlmCallResult, LlmChatInput } from './provider';

/** Default AI Endpoints base URL; overridable with OVH_AI_ENDPOINTS_BASE_URL. */
export const OVHCLOUD_DEFAULT_BASE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';

export interface OvhcloudCallOptions {
  /** AI Endpoints base URL (from OVH_AI_ENDPOINTS_BASE_URL). */
  baseUrl: string;
  /**
   * Access token (from OVH_AI_ENDPOINTS_ACCESS_TOKEN) — never logged.
   * Empty string means the anonymous free tier: no Authorization header.
   */
  apiKey: string;
  /** Abort the call after this many ms (from LLM_TIMEOUT_MS). */
  timeoutMs: number;
  /** Injectable fetch so tests never touch the network. */
  fetchImpl?: typeof fetch;
}

export async function callOvhcloud(
  input: LlmChatInput,
  opts: OvhcloudCallOptions
): Promise<LlmCallResult> {
  return callOpenAICompatible(input, {
    label: 'OVHcloud AI Endpoints',
    keyEnvVar: 'OVH_AI_ENDPOINTS_ACCESS_TOKEN',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}
