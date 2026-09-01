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
}

/**
 * The deterministic model table. Table order is the tie-break order:
 * when two models have identical cost, the one earlier in this array wins.
 * Keep this sorted by cost per 1M tokens within each capability group
 * where a stable answer is desired.
 */
export const MODEL_TABLE: readonly ModelSpec[] = [
  {
    id: 'deepseek-v3',
    provider: 'deepseek',
    capabilities: ['chat', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 0.25,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'tools', 'json'],
    costPer1MTokens: 0.6,
  },
  {
    id: 'llama-3.3-70b',
    provider: 'openrouter',
    capabilities: ['chat', 'tools', 'json', 'long-context'],
    costPer1MTokens: 0.6,
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    capabilities: ['chat', 'tools', 'json', 'long-context'],
    costPer1MTokens: 0.8,
  },
  {
    id: 'claude-3-5-haiku-vision',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'tools', 'json', 'long-context'],
    costPer1MTokens: 1.0,
  },
  {
    id: 'mistral-large-2',
    provider: 'openrouter',
    capabilities: ['chat', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 2.0,
  },
  {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    capabilities: ['chat', 'vision', 'tools', 'json', 'reasoning', 'code', 'long-context'],
    costPer1MTokens: 3.0,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    capabilities: ['chat', 'vision', 'tools', 'json', 'reasoning', 'code'],
    costPer1MTokens: 5.0,
  },
];

/** Union of every capability present on at least one model. */
export const KNOWN_CAPABILITIES: readonly Capability[] = Array.from(
  new Set(MODEL_TABLE.flatMap((m) => m.capabilities))
);