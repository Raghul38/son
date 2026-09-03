import { NoRouteError, UnknownStrategyError } from '../src/errors';
import { ModelSpec, MODEL_TABLE } from '../src/models';
import { routeRequest } from '../src/router-core';
import {
  DEFAULT_TIER_POLICIES,
  getStrategy,
  listStrategies,
  registerStrategy,
  route,
  RoutingStrategy,
} from '../src/strategy';

describe('strategy registry', () => {
  it('ships cheapest (the default) and tiered', () => {
    expect(listStrategies()).toEqual(expect.arrayContaining(['cheapest', 'tiered']));
    expect(getStrategy('cheapest').name).toBe('cheapest');
  });

  it('rejects an unknown strategy by name', () => {
    expect(() => getStrategy('nope')).toThrow(UnknownStrategyError);
    try {
      getStrategy('nope');
    } catch (err) {
      expect((err as UnknownStrategyError).code).toBe('UNKNOWN_STRATEGY');
      expect((err as Error).message).toContain('cheapest');
    }
  });

  it('accepts a custom strategy', () => {
    const custom: RoutingStrategy = {
      name: 'always-gpt-4o',
      route: () => {
        const model = MODEL_TABLE.find((m) => m.id === 'gpt-4o') as ModelSpec;
        return {
          model,
          costPer1MTokens: model.costPer1MTokens,
          strategy: 'always-gpt-4o',
          chain: [model],
          reasoning: 'test',
        };
      },
    };
    registerStrategy(custom);
    expect(route('always-gpt-4o').model.id).toBe('gpt-4o');
  });
});

describe('cheapest strategy', () => {
  it('matches routeRequest exactly (behavior is unchanged)', () => {
    const cases = [
      {},
      { capabilities: ['vision'] as const },
      { capabilities: ['reasoning'] as const, maxCostPer1MTokens: 3 },
      { maxCostPer1MTokens: 0.6 },
    ];
    for (const c of cases) {
      const legacy = routeRequest(c);
      const decision = route('cheapest', c);
      expect(decision.model.id).toBe(legacy.model.id);
      expect(decision.costPer1MTokens).toBe(legacy.costPer1MTokens);
    }
  });

  it('exposes a cheapest-first fallback chain', () => {
    const decision = route('cheapest', { capabilities: ['vision'] });
    expect(decision.chain.map((m) => m.id)).toEqual([
      'gpt-4o-mini',
      'claude-3-5-haiku-vision',
      'claude-3-5-sonnet',
      'gpt-4o',
      // No published price -> always last, never preferred.
      'meta/llama-3.2-11b-vision-instruct',
    ]);
    expect(decision.model).toBe(decision.chain[0]);
  });

  it('walks past a failed model via excludeModelIds', () => {
    const first = route('cheapest', {});
    const second = route('cheapest', { excludeModelIds: [first.model.id] });
    expect(second.model.id).not.toBe(first.model.id);
    expect(second.costPer1MTokens).toBeGreaterThanOrEqual(first.costPer1MTokens);
  });

  it('skips models whose provider is unavailable', () => {
    const decision = route('cheapest', { unavailableProviders: ['deepseek'] });
    expect(decision.model.provider).not.toBe('deepseek');
    expect(decision.model.id).toBe('gpt-4o-mini');
  });
});

describe('tiered strategy', () => {
  it('classifies the prompt and reports the tier', () => {
    const decision = route('tiered', {
      prompt: 'Prove that sqrt(2) is irrational, step by step, formally.',
    });
    expect(decision.tier).toBe('REASONING');
    expect(decision.model.capabilities).toContain('reasoning');
    expect(decision.reasoning).toContain('tier=REASONING');
  });

  it('adds the tier capability requirement even when the caller asked for none', () => {
    const table: readonly ModelSpec[] = [
      { id: 'chatty', provider: 'a', capabilities: ['chat'], costPer1MTokens: 0.1 },
      { id: 'thinker', provider: 'b', capabilities: ['chat', 'reasoning', 'code'], costPer1MTokens: 4 },
    ];
    // Cheapest would take "chatty"; the reasoning tier must not.
    expect(route('cheapest', { table }).model.id).toBe('chatty');
    expect(
      route('tiered', { prompt: 'Prove this theorem formally, step by step.', table }).model.id
    ).toBe('thinker');
  });

  it('keeps a trivial prompt on the cheapest model', () => {
    const decision = route('tiered', { prompt: 'what is the capital of France?' });
    expect(decision.tier).toBe('SIMPLE');
    expect(decision.model.id).toBe('deepseek-v3');
  });

  it('requires a code-capable model when the prompt contains code', () => {
    const table: readonly ModelSpec[] = [
      { id: 'no-code', provider: 'a', capabilities: ['chat'], costPer1MTokens: 0.1 },
      { id: 'coder', provider: 'b', capabilities: ['chat', 'code'], costPer1MTokens: 0.9 },
    ];
    const decision = route('tiered', {
      prompt: 'const x = 1; function f() { return x; } — explain this',
      table,
    });
    expect(decision.model.id).toBe('coder');
  });

  it('never overrides the caller capabilities or cost ceiling', () => {
    const decision = route('tiered', {
      prompt: 'Prove this theorem formally, step by step.',
      capabilities: ['vision'],
      maxCostPer1MTokens: 3,
    });
    expect(decision.model.id).toBe('claude-3-5-sonnet');

    expect(() =>
      route('tiered', {
        prompt: 'Prove this theorem formally, step by step.',
        maxCostPer1MTokens: 0.1,
      })
    ).toThrow(NoRouteError);
  });

  it('honors an operator preference order among eligible models', () => {
    const policies = {
      ...DEFAULT_TIER_POLICIES,
      SIMPLE: { requiredCapabilities: [], preferredModelIds: ['gpt-4o-mini'] },
    };
    const decision = route('tiered', {
      prompt: 'what is the capital of France?',
      tierPolicies: policies,
    });
    expect(decision.model.id).toBe('gpt-4o-mini');
    // The preference reorders, it never resurrects a filtered-out model.
    const filtered = route('tiered', {
      prompt: 'what is the capital of France?',
      tierPolicies: policies,
      maxCostPer1MTokens: 0.25,
    });
    expect(filtered.model.id).toBe('deepseek-v3');
  });

  it('is deterministic for the same prompt', () => {
    const ctx = { prompt: 'Design a distributed system on kubernetes' };
    const a = route('tiered', ctx);
    const b = route('tiered', ctx);
    expect(a.model.id).toBe(b.model.id);
    expect(a.tier).toBe(b.tier);
    expect(a.chain.map((m) => m.id)).toEqual(b.chain.map((m) => m.id));
  });

  it('sizes the context filter from the prompt itself', () => {
    const table: readonly ModelSpec[] = [
      {
        id: 'tiny',
        provider: 'a',
        capabilities: ['chat'],
        costPer1MTokens: 0.1,
        contextWindow: 1_000,
      },
      {
        id: 'roomy',
        provider: 'b',
        capabilities: ['chat'],
        costPer1MTokens: 2,
        contextWindow: 200_000,
      },
    ];
    const decision = route('tiered', { prompt: 'word '.repeat(4_000), table });
    expect(decision.model.id).toBe('roomy');
  });
});
