/**
 * Request pricing: what a served request cost us, and what it costs the
 * caller once the platform markup is applied.
 *
 * Sonpay owns pricing. OpenMeter is only told how many tokens were used (see
 * src/usage/openmeter.ts) — it never decides money here, and no price is ever
 * read back from it.
 *
 * Two rules shape this module, and both are about not inventing money:
 *
 *   1. A model is priced ONLY when the provider publishes BOTH a prompt rate
 *      and a completion rate (`costPer1MTokens` / `outputCostPer1MTokens` in
 *      router-core's model table). Providers price the two differently, so
 *      reusing the prompt rate for completion tokens would fabricate a cost.
 *      A model missing either rate is `not-priced` — not free, not estimated.
 *   2. Token counts come from the provider's own `usage` block. When the
 *      provider reported none, there is nothing to price; we say so instead
 *      of assuming a count.
 *
 * Everything here is pure arithmetic on numbers the caller already has, so it
 * is fully unit-testable and cannot fail at runtime.
 */
import { ModelSpec } from '@xrppay/router-core';

/** Token counts as reported by the provider (any field may be missing). */
export interface TokenCounts {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** What one served request cost, and what it is billed at. */
export interface RequestPricing {
  /** ISO-4217 code. Every published provider rate we use is quoted in USD. */
  currency: 'USD';
  /** What the upstream provider charges for this call. */
  providerCostUsd: number;
  /** The markup applied, in basis points (500 = 5%). */
  markupBps: number;
  /** providerCostUsd x (1 + markupBps/10000). */
  customerPriceUsd: number;
  /** customerPriceUsd - providerCostUsd. */
  platformFeeUsd: number;
}

/** Why a request could not be priced. Stable, machine-readable. */
export type PricingUnavailableReason =
  /** The model table publishes no prompt and/or completion rate for it. */
  | 'model-has-no-published-price'
  /** The provider returned no usable token counts, so there is nothing to price. */
  | 'no-token-usage';

export type PricingResult =
  | { priced: true; pricing: RequestPricing }
  | { priced: false; reason: PricingUnavailableReason };

/**
 * Money is rounded to 10 decimal places. A single cheap request costs a tiny
 * fraction of a cent (~1e-5 USD), so cents would round real revenue to zero;
 * 10 places keeps the value exact enough to sum over millions of requests
 * while dropping binary floating-point dust like 1.0000000000000002e-5.
 */
const USD_DECIMALS = 10;

function roundUsd(value: number): number {
  return Number(value.toFixed(USD_DECIMALS));
}

/**
 * Normalize whatever the provider reported into the three counts we use.
 * `total` is derived from input+output only when the provider did not send
 * one itself — a derived sum of two reported numbers is arithmetic, not a
 * guess. Anything not reported stays undefined.
 */
export function normalizeTokens(usage: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
} | undefined): TokenCounts {
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const reportedTotal = usage?.total_tokens;
  const derivedTotal =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? derivedTotal,
  };
}

/**
 * What the provider charges for this call, or undefined when its published
 * rates do not cover it.
 *
 * Both token counts are required: a model that charges for completion tokens
 * cannot be costed from prompt tokens alone.
 */
export function computeProviderCostUsd(
  model: Pick<ModelSpec, 'costPer1MTokens' | 'outputCostPer1MTokens'>,
  tokens: TokenCounts
): number | undefined {
  const inputRate = model.costPer1MTokens;
  const outputRate = model.outputCostPer1MTokens;
  if (inputRate === undefined || outputRate === undefined) return undefined;
  const { inputTokens, outputTokens } = tokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return roundUsd((inputTokens * inputRate + outputTokens * outputRate) / 1_000_000);
}

/**
 * Price one served request: provider cost, then the platform markup on top.
 *
 * @param markupBps Platform markup in basis points (PLATFORM_MARKUP_BPS,
 *   default 500 = 5%). 0 is legal and means "charge cost".
 */
export function priceRequest(
  model: Pick<ModelSpec, 'costPer1MTokens' | 'outputCostPer1MTokens'>,
  tokens: TokenCounts,
  markupBps: number
): PricingResult {
  if (tokens.inputTokens === undefined || tokens.outputTokens === undefined) {
    return { priced: false, reason: 'no-token-usage' };
  }
  const providerCostUsd = computeProviderCostUsd(model, tokens);
  if (providerCostUsd === undefined) {
    return { priced: false, reason: 'model-has-no-published-price' };
  }
  const customerPriceUsd = roundUsd(providerCostUsd * (1 + markupBps / 10_000));
  return {
    priced: true,
    pricing: {
      currency: 'USD',
      providerCostUsd,
      markupBps,
      customerPriceUsd,
      // Derived from the two rounded figures so the three always reconcile:
      // cost + fee === price, exactly, in the numbers we return.
      platformFeeUsd: roundUsd(customerPriceUsd - providerCostUsd),
    },
  };
}
