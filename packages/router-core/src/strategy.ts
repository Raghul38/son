/**
 * Routing strategies and the strategy registry.
 *
 * Adapted from ClawRouter (BlockRunAI/ClawRouter), MIT (c) 2026 BlockRunAI —
 * commit 6bc5a30764cf, `dist/router/index.js` (bundled `@blockrun/router-core`).
 * See THIRD_PARTY_NOTICES.md.
 *
 * Kept from upstream: the pluggable strategy interface plus
 * register/get/route registry, and the tier model (a classified prompt picks a
 * tier, the tier names a primary model and a fallback chain).
 *
 * Changed for SonPay: strategies return this repo's `ModelSpec` (chosen from
 * the operator's model table) instead of BlockRun gateway model ids, and the
 * default strategy is the pre-existing cheapest-capable router so the shipped
 * behavior is unchanged unless an operator opts in to `tiered`.
 *
 * Pure module: no network, no payment, no I/O, no clock. Routing happens
 * strictly AFTER the x402 payment layer has verified payment — nothing here
 * knows or cares about payments.
 */
import {
  applyPreference,
  CandidateQuery,
  selectCandidates,
} from './candidates';
import {
  Classification,
  ClassifierConfig,
  classifyPrompt,
  DEFAULT_CLASSIFIER_CONFIG,
  estimateTokens,
  Tier,
} from './classify';
import { UnknownStrategyError } from './errors';
import { Capability, ModelId, ModelSpec, MODEL_TABLE } from './models';

/** What a tier requires of a model. */
export interface TierPolicy {
  /** Capabilities every model serving this tier must have. */
  readonly requiredCapabilities: readonly Capability[];
  /**
   * Operator preference order, ClawRouter's `{ primary, fallback[] }` chain
   * flattened. Ids that a filter rejected are ignored (see applyPreference).
   */
  readonly preferredModelIds?: readonly ModelId[];
}

/**
 * Default tier policies. They add CAPABILITY requirements only — no invented
 * quality ranking — so cost stays the deciding factor and the default table
 * needs no per-model quality data to be trustworthy. An operator that wants
 * ClawRouter-style named chains sets `preferredModelIds` per tier.
 */
export const DEFAULT_TIER_POLICIES: Readonly<Record<Tier, TierPolicy>> = Object.freeze({
  SIMPLE: { requiredCapabilities: [] },
  MEDIUM: { requiredCapabilities: [] },
  COMPLEX: { requiredCapabilities: ['reasoning'] },
  REASONING: { requiredCapabilities: ['reasoning'] },
});

/** Everything a strategy may look at. Every field is optional. */
export interface RoutingContext extends CandidateQuery {
  /** The user prompt, for strategies that classify it. */
  readonly prompt?: string;
  /** The system prompt, when the caller sends one. */
  readonly systemPrompt?: string;
  /** Caller declares it needs JSON/schema-shaped output. */
  readonly requiresStructuredOutput?: boolean;
  /** Model table to route against. Defaults to MODEL_TABLE. */
  readonly table?: readonly ModelSpec[];
  /** Per-tier overrides; defaults to DEFAULT_TIER_POLICIES. */
  readonly tierPolicies?: Readonly<Record<Tier, TierPolicy>>;
  /** Classifier overrides; defaults to DEFAULT_CLASSIFIER_CONFIG. */
  readonly classifierConfig?: ClassifierConfig;
}

/** A routing decision: the chosen model plus how it was chosen. */
export interface RoutingDecision {
  /** The chosen model (the head of `chain`). */
  readonly model: ModelSpec;
  /** Convenience copy of `model.costPer1MTokens`. */
  readonly costPer1MTokens: number;
  /** Name of the strategy that produced this decision. */
  readonly strategy: string;
  /**
   * Ordered fallback chain, primary first: every model that satisfies the
   * request, best first. The caller may walk it when a provider call fails.
   */
  readonly chain: readonly ModelSpec[];
  /** Tier, when the strategy classified the prompt. */
  readonly tier?: Tier;
  /** Classifier confidence in [0, 1], when the strategy classified. */
  readonly confidence?: number;
  /** Short human-readable explanation for logs. */
  readonly reasoning: string;
  /** Full classification, when the strategy ran one (for debugging/logs). */
  readonly classification?: Classification;
}

export interface RoutingStrategy {
  readonly name: string;
  route(context: RoutingContext): RoutingDecision;
}

/**
 * Cheapest-capable routing — SonPay's original, unchanged behavior and the
 * default strategy: filter by capability + cost ceiling, take the cheapest
 * survivor, ties broken by table order.
 */
export const cheapestStrategy: RoutingStrategy = {
  name: 'cheapest',
  route(context: RoutingContext): RoutingDecision {
    const chain = selectCandidates(toQuery(context), context.table ?? MODEL_TABLE);
    return {
      model: chain[0],
      costPer1MTokens: chain[0].costPer1MTokens,
      strategy: 'cheapest',
      chain,
      reasoning: 'cheapest capable model',
    };
  },
};

/**
 * Tiered routing: classify the prompt, let the tier add capability
 * requirements on top of the caller's, then pick the cheapest model that
 * satisfies all of them. A trivial prompt therefore keeps landing on the
 * cheap model, while a prompt that asks for proofs or code is guaranteed a
 * reasoning/code-capable model even when the caller declared no capabilities.
 */
export const tieredStrategy: RoutingStrategy = {
  name: 'tiered',
  route(context: RoutingContext): RoutingDecision {
    const table = context.table ?? MODEL_TABLE;
    const classification = classifyPrompt(
      {
        prompt: context.prompt ?? '',
        systemPrompt: context.systemPrompt,
        requiresStructuredOutput: context.requiresStructuredOutput,
      },
      context.classifierConfig ?? DEFAULT_CLASSIFIER_CONFIG
    );

    const policies = context.tierPolicies ?? DEFAULT_TIER_POLICIES;
    const policy = policies[classification.tier];

    // Tier requirements are ADDED to the caller's, never substituted for
    // them: a caller that asked for vision still gets vision.
    const required = new Set<Capability>([
      ...(context.capabilities ?? []),
      ...policy.requiredCapabilities,
    ]);
    // A prompt that contains code gets a code-capable model. This comes from
    // the classifier's own codePresence signal, not from a hand-written list.
    if (dimensionFired(classification, 'codePresence')) {
      required.add('code');
    }

    const query: CandidateQuery = {
      ...toQuery(context),
      capabilities: [...required],
      estimatedInputTokens:
        context.estimatedInputTokens ??
        estimateTokens(`${context.systemPrompt ?? ''} ${context.prompt ?? ''}`),
    };

    const ranked = selectCandidates(query, table);
    const chain = applyPreference(ranked, policy.preferredModelIds ?? []);

    return {
      model: chain[0],
      costPer1MTokens: chain[0].costPer1MTokens,
      strategy: 'tiered',
      chain,
      tier: classification.tier,
      confidence: classification.confidence,
      reasoning: `tier=${classification.tier} | ${classification.reasoning}`,
      classification,
    };
  },
};

function dimensionFired(classification: Classification, name: string): boolean {
  const dimension = classification.dimensions.find((d) => d.name === name);
  return dimension !== undefined && dimension.score > 0;
}

/** Narrow a RoutingContext down to the filter inputs. */
function toQuery(context: RoutingContext): CandidateQuery {
  return {
    capabilities: context.capabilities,
    maxCostPer1MTokens: context.maxCostPer1MTokens,
    excludeModelIds: context.excludeModelIds,
    unavailableProviders: context.unavailableProviders,
    estimatedInputTokens: context.estimatedInputTokens,
    requestedOutputTokens: context.requestedOutputTokens,
  };
}

const registry = new Map<string, RoutingStrategy>([
  [cheapestStrategy.name, cheapestStrategy],
  [tieredStrategy.name, tieredStrategy],
]);

/** Register (or replace) a strategy. */
export function registerStrategy(strategy: RoutingStrategy): void {
  registry.set(strategy.name, strategy);
}

/** Look a strategy up by name. Throws UnknownStrategyError if absent. */
export function getStrategy(name: string): RoutingStrategy {
  const strategy = registry.get(name);
  if (strategy === undefined) {
    throw new UnknownStrategyError(name, listStrategies());
  }
  return strategy;
}

/** Names of every registered strategy, in registration order. */
export function listStrategies(): readonly string[] {
  return [...registry.keys()];
}

/** Route with a named strategy. */
export function route(name: string, context: RoutingContext = {}): RoutingDecision {
  return getStrategy(name).route(context);
}
