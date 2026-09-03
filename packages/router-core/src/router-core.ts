import { Capability, ModelSpec, MODEL_TABLE } from './models';
import { selectCandidates } from './candidates';

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
  // The filtering/ordering lives in candidates.ts so the tiered strategy and
  // the fallback chain reuse exactly this logic. Passing only the two
  // historical constraints keeps the behavior — and the thrown reasons —
  // identical to the original implementation.
  const candidates = selectCandidates(
    {
      capabilities: request.capabilities,
      maxCostPer1MTokens: request.maxCostPer1MTokens,
    },
    table
  );

  // selectCandidates returns cheapest-first with table order as the tie-break.
  const best = candidates[0];
  return { model: best, costPer1MTokens: best.costPer1MTokens };
}

export type { Capability, ModelSpec, ModelId } from './models';
export {
  RouterError,
  UnknownCapabilityError,
  UnknownStrategyError,
  NoRouteError,
} from './errors';
export type { NoRouteReason } from './errors';