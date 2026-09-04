/**
 * The model catalog, as the outside world sees it.
 *
 * router-core owns the model table and stays pure; this module is a read-only
 * projection of it for the Models page and the landing page. It adds the two
 * things the table deliberately does not know — whether THIS server can
 * actually call a provider right now, and what the provider's free tier is —
 * and it invents nothing else: a rate the provider does not publish stays
 * absent here exactly as it is absent in the table.
 */
import { Capability, MODEL_TABLE } from '@xrppay/router-core';
import { providerSupport, ProviderSupport } from './chat';
import { ServerConfig } from './config';

/** Whether a served request through this model can be costed. */
export type CatalogPricing =
  /** Both a prompt and a completion rate are published — the request is priced. */
  | 'published'
  /** Only a prompt rate is published, so the request is metered but unpriced. */
  | 'prompt-only'
  /** No published per-token price at all. */
  | 'none';

/**
 * A provider's free tier, where this repo has verified one. Absent means "no
 * verified free tier", never "paid" by assumption.
 */
export interface FreeTier {
  name: string;
  /** The published limit, quoted verbatim rather than summarised as "free". */
  limit: string;
  /** True when THIS server's configuration is actually using the free tier. */
  active: boolean;
}

export interface CatalogModel {
  id: string;
  provider: string;
  capabilities: readonly Capability[];
  /** USD per 1M prompt tokens, when the provider publishes one. */
  inputCostPer1MTokens?: number;
  /** USD per 1M completion tokens, when the provider publishes one. */
  outputCostPer1MTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * `live` = a real adapter with credentials answers this model.
   * `stub` = routed requests get the placeholder answer (`stub: true`).
   */
  availability: 'live' | 'stub';
  /** Why it is not live: no adapter in this server, or no credentials. */
  availabilityReason?: Exclude<ProviderSupport, 'live'>;
  pricing: CatalogPricing;
  freeTier?: FreeTier;
}

/**
 * Free tiers this repo has verified, keyed by provider. The limits are the
 * providers' own published numbers (see .env.example) — not estimates, and
 * not a claim that using the model is free for the caller: the caller always
 * pays the x402 price.
 */
function freeTierFor(provider: string, config: ServerConfig): FreeTier | undefined {
  switch (provider) {
    case 'ovhcloud':
      return {
        name: 'Anonymous tier',
        limit: '2 requests/min per IP per model',
        active: config.ovhApiKey === '' && config.ovhAllowAnonymous,
      };
    case 'nvidia':
      return {
        name: 'Free developer tier',
        limit: '~40 requests/min, no card',
        active: config.nvidiaApiKey !== '',
      };
    default:
      return undefined;
  }
}

function pricingOf(input?: number, output?: number): CatalogPricing {
  if (input !== undefined && output !== undefined) return 'published';
  if (input !== undefined) return 'prompt-only';
  return 'none';
}

/** The whole catalog, in the model table's own (cost-ordered) order. */
export function buildCatalog(config: ServerConfig): CatalogModel[] {
  return MODEL_TABLE.map((model) => {
    const support = providerSupport(model.provider, config);
    return {
      id: model.id,
      provider: model.provider,
      capabilities: model.capabilities,
      ...(model.costPer1MTokens !== undefined && {
        inputCostPer1MTokens: model.costPer1MTokens,
      }),
      ...(model.outputCostPer1MTokens !== undefined && {
        outputCostPer1MTokens: model.outputCostPer1MTokens,
      }),
      ...(model.contextWindow !== undefined && { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens !== undefined && { maxOutputTokens: model.maxOutputTokens }),
      availability: support === 'live' ? ('live' as const) : ('stub' as const),
      ...(support !== 'live' && { availabilityReason: support }),
      pricing: pricingOf(model.costPer1MTokens, model.outputCostPer1MTokens),
      ...(freeTierFor(model.provider, config) !== undefined && {
        freeTier: freeTierFor(model.provider, config) as FreeTier,
      }),
    };
  });
}

/** One row per provider, for the landing page's provider strip. */
export interface CatalogProvider {
  name: string;
  models: number;
  availability: 'live' | 'stub';
  availabilityReason?: Exclude<ProviderSupport, 'live'>;
  freeTier?: FreeTier;
}

export function buildProviders(config: ServerConfig): CatalogProvider[] {
  const names = Array.from(new Set(MODEL_TABLE.map((m) => m.provider)));
  return names.map((name) => {
    const support = providerSupport(name, config);
    return {
      name,
      models: MODEL_TABLE.filter((m) => m.provider === name).length,
      availability: support === 'live' ? ('live' as const) : ('stub' as const),
      ...(support !== 'live' && { availabilityReason: support }),
      ...(freeTierFor(name, config) !== undefined && {
        freeTier: freeTierFor(name, config) as FreeTier,
      }),
    };
  });
}
