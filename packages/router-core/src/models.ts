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
  /** Cost in USD per 1M input tokens. Used for cheapest-match routing. */
  readonly costPer1MTokens: number;
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
];

/** Union of every capability present on at least one model. */
export const KNOWN_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(MODEL_TABLE.flatMap((m) => m.capabilities))
);