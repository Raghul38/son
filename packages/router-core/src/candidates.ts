/**
 * Candidate selection: model table -> ordered list of eligible models.
 *
 * Adapted from ClawRouter (BlockRunAI/ClawRouter), MIT (c) 2026 BlockRunAI —
 * commit 6bc5a30764cf, `dist/router/index.js` (bundled `@blockrun/router-core`).
 * See THIRD_PARTY_NOTICES.md.
 *
 * Kept from upstream: the filter set (capability/tool-calling, vision, exclude
 * list, unavailable models, context capacity with the 1.1x head-room factor)
 * and the "unknown limit means keep the model" rule.
 *
 * Deliberately CHANGED for SonPay: upstream's filters are *soft* — when a
 * filter empties the candidate list it silently reverts to the unfiltered
 * list, because BlockRun would rather serve a slightly wrong model than fail.
 * SonPay is payment-gated: a caller has paid for a model that meets the
 * constraints it asked for, so every filter here is *hard* and an empty list
 * raises NoRouteError with the reason naming the filter that emptied it. The
 * server turns that into a 400 before the request is served.
 *
 * Pure module: no network, no payment, no I/O, no clock.
 */
import { Capability, ModelId, ModelSpec, MODEL_TABLE } from './models';
import { NoRouteError, UnknownCapabilityError } from './errors';

/** Head-room factor applied to the estimated token usage (upstream's 1.1x). */
export const CAPACITY_HEADROOM = 1.1;

/** Every constraint a candidate must satisfy. All fields are optional. */
export interface CandidateQuery {
  /** Capabilities the model MUST have (AND, not OR). */
  readonly capabilities?: readonly Capability[];
  /** Maximum cost per 1M input tokens; a model priced exactly at it passes. */
  readonly maxCostPer1MTokens?: number;
  /** Model ids the caller refuses (e.g. "already tried and it failed"). */
  readonly excludeModelIds?: readonly ModelId[];
  /**
   * Providers currently known to be down/unconfigured. Undefined means "no
   * availability information" — nothing is filtered out.
   */
  readonly unavailableProviders?: readonly string[];
  /** Estimated prompt size, used by the capacity filter. */
  readonly estimatedInputTokens?: number;
  /** Requested completion size, used by the capacity filter. */
  readonly requestedOutputTokens?: number;
}

/**
 * Apply every filter, then order the survivors deterministically:
 * cheapest first, ties broken by table order.
 *
 * Throws UnknownCapabilityError for a capability no model in the table has,
 * and NoRouteError when a filter leaves no candidate. The error precedence is
 * the historical one — capability filter, then cost ceiling — so existing
 * callers see exactly the same reasons they always did.
 */
export function selectCandidates(
  query: CandidateQuery = {},
  table: readonly ModelSpec[] = MODEL_TABLE
): readonly ModelSpec[] {
  if (table.length === 0) {
    throw new NoRouteError('empty-model-table');
  }

  const required: readonly Capability[] = query.capabilities ?? [];
  const known = Array.from(new Set(table.flatMap((m) => m.capabilities)));
  for (const cap of required) {
    if (!(known as readonly string[]).includes(cap)) {
      throw new UnknownCapabilityError(cap, known);
    }
  }

  let candidates: readonly ModelSpec[] = table;

  // (a) capability filter — every requested capability must be present.
  for (const cap of required) {
    candidates = candidates.filter((m) => m.capabilities.includes(cap));
  }

  // (b) cost ceiling.
  const ceiling = query.maxCostPer1MTokens;
  if (ceiling !== undefined) {
    candidates = candidates.filter((m) => m.costPer1MTokens <= ceiling);
  }

  if (candidates.length === 0) {
    throw new NoRouteError(
      ceiling !== undefined ? 'no-model-under-cost-ceiling' : 'no-model-matches'
    );
  }

  // (c) exclude list — used to walk a fallback chain past models that failed.
  const excluded = new Set(query.excludeModelIds ?? []);
  if (excluded.size > 0) {
    candidates = candidates.filter((m) => !excluded.has(m.id));
    if (candidates.length === 0) throw new NoRouteError('all-models-excluded');
  }

  // (d) provider availability — a provider with no credentials or a known
  //     outage is not a candidate, however cheap its models are.
  const down = new Set(query.unavailableProviders ?? []);
  if (down.size > 0) {
    candidates = candidates.filter((m) => !down.has(m.provider));
    if (candidates.length === 0) throw new NoRouteError('no-available-provider');
  }

  // (e) capacity — the model must fit the prompt plus the requested output,
  //     with head-room. Models that do not publish a limit are kept.
  const input = query.estimatedInputTokens ?? 0;
  const output = query.requestedOutputTokens ?? 0;
  if (input > 0 || output > 0) {
    const needed = (input + output) * CAPACITY_HEADROOM;
    candidates = candidates.filter((m) => {
      if (m.contextWindow !== undefined && m.contextWindow < needed) return false;
      if (m.maxOutputTokens !== undefined && output > m.maxOutputTokens) return false;
      return true;
    });
    if (candidates.length === 0) throw new NoRouteError('no-model-with-enough-context');
  }

  return rankByCost(candidates);
}

/**
 * Deterministic ranking: cheapest first; equal cost keeps table order.
 * `Array.prototype.sort` is stable in every supported Node version, so the
 * tie-break is the table order the operator wrote.
 */
export function rankByCost(models: readonly ModelSpec[]): readonly ModelSpec[] {
  return [...models].sort((a, b) => a.costPer1MTokens - b.costPer1MTokens);
}

/**
 * Move `preferred` model ids (in the order given) to the front of an already
 * ranked list. Ids that are not in the list are ignored — a preference can
 * never resurrect a model that a filter rejected. This is SonPay's version of
 * ClawRouter's per-tier `{ primary, fallback[] }` chain: the operator states a
 * preference order, but the filters stay authoritative.
 */
export function applyPreference(
  models: readonly ModelSpec[],
  preferred: readonly ModelId[]
): readonly ModelSpec[] {
  if (preferred.length === 0) return models;
  const byId = new Map(models.map((m) => [m.id, m]));
  const head: ModelSpec[] = [];
  for (const id of preferred) {
    const model = byId.get(id);
    if (model !== undefined && !head.includes(model)) head.push(model);
  }
  if (head.length === 0) return models;
  const headIds = new Set(head.map((m) => m.id));
  return [...head, ...models.filter((m) => !headIds.has(m.id))];
}
