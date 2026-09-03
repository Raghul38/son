/**
 * Model table for the XRP-Pay Router.
 *
 * Deterministic, static data only — this module must never import network,
 * payment, or I/O code so that routing stays unit-testable in isolation.
 */

/** Known capability identifiers understood by the router. */
export type Capability =
  | 'chat'
  | 'vision'
  | 'tools'
  | 'json'
  | 'reasoning'
  | 'code'
  | 'long-context';

export type ModelId = string;

export interface ModelSpec {
  /** Stable unique id, e.g. "gpt-4o-mini". */
  readonly id: ModelId;
  /** Provider / gateway that hosts the model. */
  readonly provider: string;
  /** Capabilities this model supports. */
  readonly capabilities: readonly Capability[];
  /**
   * Cost in USD per 1M input tokens. Used for cheapest-match routing.
   *
   * Optional, and `undefined` means "the provider publishes no per-token
   * price" — not "free". NVIDIA's hosted build.nvidia.com endpoints are the
   * case that forced this: they are rate-limited and free for evaluation, but
   * NVIDIA quotes no token price and its terms put production use under
   * NVIDIA AI Enterprise, so recording either 0 or a guess would be a lie.
   *
   * A router that does not know a price must not prefer that model, so an
   * unknown price sorts LAST and is rejected by any explicit cost ceiling.
   * Such a model is still reachable: as a fallback after a cheaper model
   * fails, or when it is the only candidate its provider offers.
   */
  readonly costPer1MTokens?: number;
  /**
   * Total context window in tokens, as published by the provider. Optional:
   * when it is undefined the capacity filter treats the model as "unknown
   * capacity" and keeps it (same as ClawRouter's capacity filter).
   */
  readonly contextWindow?: number;
  /**
   * Maximum tokens the model can emit in one response, when published.
   * Optional for the same reason as `contextWindow`.
   */
  readonly maxOutputTokens?: number;
}

/**
 * The deterministic model table. Table order is the tie-break order:
 * when two models have identical cost, the one earlier in this array wins.
 * Keep this sorted by cost per 1M tokens within each capability group
 * where a stable answer is desired.
 *
 * `contextWindow` / `maxOutputTokens` mirror the providers' published limits
 * and feed the capacity filter. They are deliberately left out where the
 * provider does not publish a stable number — an absent limit means "unknown",
 * and the capacity filter keeps such a model rather than guessing.
 */
export const MODEL_TABLE: readonly ModelSpec[] = [
  {
    id: 'deepseek-v3',
    provider: 'deepseek',
    capabilities: ['chat', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 0.25,
    contextWindow: 64_000,
    maxOutputTokens: 8_000,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'tools', 'json'],
    costPer1MTokens: 0.6,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },
  {
    id: 'llama-3.3-70b',
    provider: 'openrouter',
    capabilities: ['chat', 'tools', 'json', 'long-context'],
    costPer1MTokens: 0.6,
    contextWindow: 128_000,
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    capabilities: ['chat', 'tools', 'json', 'long-context'],
    costPer1MTokens: 0.8,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
  {
    id: 'claude-3-5-haiku-vision',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'tools', 'json', 'long-context'],
    costPer1MTokens: 1.0,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
  {
    id: 'mistral-large-2',
    provider: 'openrouter',
    capabilities: ['chat', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 2.0,
    contextWindow: 128_000,
  },
  {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'tools', 'json', 'reasoning', 'code', 'long-context'],
    costPer1MTokens: 3.0,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 5.0,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
  },

  // --- OVHcloud AI Endpoints ---------------------------------------------
  // Ids, prices and limits are copied from OVHcloud's PUBLIC catalog
  // (GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models, read
  // 2026-09-03), which quotes `pricing.prompt` in USD per token — the values
  // below are that number x 1e6. Nothing here is estimated.
  {
    id: 'Qwen3.5-397B-A17B',
    provider: 'ovhcloud',
    // Catalog gives no capability metadata, so this claims only what an
    // instruct-tuned chat model plainly does. "reasoning" is deliberately not
    // claimed: it would be an unverified assertion, and it would let this
    // model capture reasoning traffic from cheaper verified candidates.
    capabilities: ['chat', 'tools', 'json', 'code', 'long-context'],
    costPer1MTokens: 0.71, // catalog: prompt 0.00000071 USD/token
    contextWindow: 262_144,
    maxOutputTokens: 262_144,
  },
  {
    id: 'Meta-Llama-3_3-70B-Instruct',
    provider: 'ovhcloud',
    capabilities: ['chat', 'tools', 'json', 'long-context'],
    costPer1MTokens: 0.74, // catalog: prompt 0.00000074 USD/token
    contextWindow: 131_072,
    maxOutputTokens: 131_072,
  },

  // --- NVIDIA NIM (hosted build.nvidia.com endpoints) ---------------------
  // Ids come from the PUBLIC catalog (GET
  // https://integrate.api.nvidia.com/v1/models, read 2026-09-02) — NVIDIA
  // retires models on published EOL dates and answers 410 Gone afterwards, so
  // these must be re-checked against the catalog, never remembered.
  // `costPer1MTokens` is intentionally absent: NVIDIA publishes no per-token
  // price for these endpoints (see the field's doc comment above).
  {
    id: 'nvidia/llama-3.1-nemotron-70b-instruct',
    provider: 'nvidia',
    capabilities: ['chat', 'reasoning', 'code'],
  },
  {
    id: 'meta/llama-3.2-11b-vision-instruct',
    provider: 'nvidia',
    capabilities: ['chat', 'vision'],
  },
];

/** Union of every capability present on at least one model. */
export const KNOWN_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(MODEL_TABLE.flatMap((m) => m.capabilities))
);