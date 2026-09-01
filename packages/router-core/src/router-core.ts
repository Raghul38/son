import { Capability, ModelSpec, MODEL_TABLE } from './models';
import { NoRouteError, UnknownCapabilityError } from './errors';

export interface RouteRequest {
  /**
   * Required capabilities. Empty/undefined means no capability filter —
   * all models are candidates.
   */
  capabilities?: readonly Capability[];
  /**
   * Maximum allowed cost per 1M tokens. Models strictly above this price
   * are excluded; a model priced exactly at the ceiling is allowed.
   */
  maxCostPer1MTokens?: number;
}

export interface RouteResult {
  /** The chosen model. */
  model: ModelSpec;
  /** Selected model's cost per 1M tokens (copy of `model.costPer1MTokens`). */
  costPer1MTokens: number;
}

/**
 * Deterministically choose the cheapest model that satisfies the request:
 *   1. capability filter (every requested capability must be present),
 *   2. cost ceiling (model cost must be <= maxCostPer1MTokens),
 *   3. cheapest-match among the survivors — ties broken by table order.
 *
 * Pure function: no network, no payment, no I/O. Fully unit-testable.
 *
 * Throws:
 *   - UnknownCapabilityError if a requested capability is unknown to all models.
 *   - NoRouteError if no model satisfies the capability filter and/or cost ceiling.
 *
 * @param table Model table to route against. Defaults to the standard MODEL_TABLE;
 *   injectable so tie-breaking and edge cases can be tested deterministically.
 */
export function routeRequest(
  request: RouteRequest = {},
  table: readonly ModelSpec[] = MODEL_TABLE
): RouteResult {
  const required: readonly Capability[] = request.capabilities ?? [];
  const known = Array.from(new Set(table.flatMap((m) => m.capabilities)));

  if (table.length === 0) {
    throw new NoRouteError('empty-model-table');
  }

  // Validate requested capabilities before filtering.
  for (const cap of required) {
    if (!(known as readonly string[]).includes(cap)) {
      throw new UnknownCapabilityError(cap, known);
    }
  }

  let candidates: readonly ModelSpec[] = table;

  // (a) capability filter
  for (const cap of required) {
    candidates = candidates.filter((m) => m.capabilities.includes(cap));
  }

  // (b) cost ceiling
  const ceiling = request.maxCostPer1MTokens;
  if (ceiling !== undefined) {
    candidates = candidates.filter((m) => m.costPer1MTokens <= ceiling);
  }

  if (candidates.length === 0) {
    const reason =
      ceiling !== undefined ? 'no-model-under-cost-ceiling' : 'no-model-matches';
    throw new NoRouteError(reason);
  }

  // (c) cheapest match; ties broken by table order (first minimal-cost model wins).
  let best: ModelSpec = candidates[0];
  for (const m of candidates) {
    if (m.costPer1MTokens < best.costPer1MTokens) {
      best = m;
    }
  }

  return { model: best, costPer1MTokens: best.costPer1MTokens };
}

export type { Capability, ModelSpec, ModelId } from './models';
export {
  RouterError,
  UnknownCapabilityError,
  NoRouteError,
} from './errors';
export type { NoRouteReason } from './errors';