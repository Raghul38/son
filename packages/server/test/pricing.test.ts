/**
 * Pricing math: provider cost, platform markup, platform fee.
 *
 * Pure arithmetic, no network, no OpenMeter — Sonpay owns pricing, and this
 * file is where that ownership is pinned down. The two rules under test are
 * "both published rates or no price at all" and "no reported tokens, no
 * price": everything else would mean inventing money.
 */
import { MODEL_TABLE, ModelSpec } from '@xrppay/router-core';
import {
  computeProviderCostUsd,
  normalizeTokens,
  priceRequest,
} from '../src/pricing';

/** The real table entries these tests price against. */
function model(id: string): ModelSpec {
  const found = MODEL_TABLE.find((m) => m.id === id);
  if (found === undefined) throw new Error(`no such model in the table: ${id}`);
  return found;
}

const LLAMA = model('Meta-Llama-3_3-70B-Instruct'); // 0.74 in / 0.74 out
const QWEN = model('Qwen3.5-397B-A17B'); // 0.71 in / 4.25 out
const NEMOTRON = model('nvidia/llama-3.1-nemotron-70b-instruct'); // no rates
const DEEPSEEK = model('deepseek-v3'); // input rate only

describe('normalizeTokens', () => {
  it('passes through the provider\'s own counts', () => {
    expect(
      normalizeTokens({ prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 })
    ).toEqual({ inputTokens: 16, outputTokens: 9, totalTokens: 25 });
  });

  it('derives the total when the provider only reported the parts', () => {
    expect(normalizeTokens({ prompt_tokens: 16, completion_tokens: 9 })).toEqual({
      inputTokens: 16,
      outputTokens: 9,
      totalTokens: 25,
    });
  });

  it('trusts the provider\'s total over the sum when both are present', () => {
    // Some providers count cached/reasoning tokens in the total; theirs wins.
    expect(
      normalizeTokens({ prompt_tokens: 16, completion_tokens: 9, total_tokens: 30 })
    ).toEqual({ inputTokens: 16, outputTokens: 9, totalTokens: 30 });
  });

  it('never invents a count it was not given', () => {
    expect(normalizeTokens({ prompt_tokens: 16 })).toEqual({
      inputTokens: 16,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    expect(normalizeTokens(undefined)).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      totalTokens: undefined,
    });
  });
});

describe('computeProviderCostUsd', () => {
  it('charges prompt and completion tokens at their own published rates', () => {
    // Qwen3.5 costs 6x more per completion token than per prompt token, which
    // is exactly why one blended rate would be wrong.
    // (12 x 0.71 + 5 x 4.25) / 1e6
    expect(computeProviderCostUsd(QWEN, { inputTokens: 12, outputTokens: 5 })).toBe(
      0.00002977
    );
  });

  it('is exact for a model whose rates are equal', () => {
    // (16 + 9) x 0.74 / 1e6
    expect(computeProviderCostUsd(LLAMA, { inputTokens: 16, outputTokens: 9 })).toBe(
      0.0000185
    );
  });

  it('costs a zero-token call at zero, not as unknown', () => {
    expect(computeProviderCostUsd(LLAMA, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('returns undefined for a model with no published rates at all', () => {
    expect(
      computeProviderCostUsd(NEMOTRON, { inputTokens: 12, outputTokens: 5 })
    ).toBeUndefined();
  });

  it('returns undefined when only the prompt rate is published', () => {
    // Half a price is not a price: reusing the prompt rate for completion
    // tokens would fabricate the completion side of the bill.
    expect(DEEPSEEK.costPer1MTokens).toBeDefined();
    expect(DEEPSEEK.outputCostPer1MTokens).toBeUndefined();
    expect(
      computeProviderCostUsd(DEEPSEEK, { inputTokens: 12, outputTokens: 5 })
    ).toBeUndefined();
  });

  it('returns undefined when the provider reported no token counts', () => {
    expect(computeProviderCostUsd(LLAMA, {})).toBeUndefined();
    expect(computeProviderCostUsd(LLAMA, { inputTokens: 12 })).toBeUndefined();
  });
});

describe('priceRequest — 5% platform fee', () => {
  it('adds exactly 5% at the default 500 bps', () => {
    const result = priceRequest(LLAMA, { inputTokens: 16, outputTokens: 9 }, 500);
    expect(result).toEqual({
      priced: true,
      pricing: {
        currency: 'USD',
        providerCostUsd: 0.0000185,
        markupBps: 500,
        customerPriceUsd: 0.000019425, // 0.0000185 x 1.05
        platformFeeUsd: 0.000000925, // 5% of cost
      },
    });
  });

  it('keeps cost + fee === customer price', () => {
    const result = priceRequest(QWEN, { inputTokens: 12, outputTokens: 5 }, 500);
    if (!result.priced) throw new Error('expected a priced result');
    const { providerCostUsd, platformFeeUsd, customerPriceUsd } = result.pricing;
    expect(providerCostUsd + platformFeeUsd).toBeCloseTo(customerPriceUsd, 12);
    expect(platformFeeUsd / providerCostUsd).toBeCloseTo(0.05, 12);
  });

  it('honors a different markup', () => {
    const result = priceRequest(LLAMA, { inputTokens: 16, outputTokens: 9 }, 1000);
    if (!result.priced) throw new Error('expected a priced result');
    expect(result.pricing.customerPriceUsd).toBe(0.00002035); // x 1.10
    expect(result.pricing.platformFeeUsd).toBe(0.00000185);
  });

  it('charges cost with no fee at 0 bps', () => {
    const result = priceRequest(LLAMA, { inputTokens: 16, outputTokens: 9 }, 0);
    if (!result.priced) throw new Error('expected a priced result');
    expect(result.pricing.customerPriceUsd).toBe(result.pricing.providerCostUsd);
    expect(result.pricing.platformFeeUsd).toBe(0);
  });

  it('reports an unpriced model instead of guessing a price', () => {
    expect(priceRequest(NEMOTRON, { inputTokens: 12, outputTokens: 5 }, 500)).toEqual({
      priced: false,
      reason: 'model-has-no-published-price',
    });
  });

  it('reports missing usage instead of assuming a token count', () => {
    expect(priceRequest(LLAMA, {}, 500)).toEqual({
      priced: false,
      reason: 'no-token-usage',
    });
  });

  it('does not round a real charge down to zero', () => {
    // One cheap request costs a small fraction of a cent; rounding to cents
    // would erase the platform fee entirely.
    const result = priceRequest(LLAMA, { inputTokens: 1, outputTokens: 1 }, 500);
    if (!result.priced) throw new Error('expected a priced result');
    expect(result.pricing.providerCostUsd).toBeGreaterThan(0);
    expect(result.pricing.platformFeeUsd).toBeGreaterThan(0);
  });
});
