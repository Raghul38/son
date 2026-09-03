import {
  Capability,
  ModelSpec,
  MODEL_TABLE,
  NoRouteError,
  RouterError,
  routeRequest,
  UnknownCapabilityError,
} from '../src/index';

/** Small custom table used to exercise tie-breaking deterministically. */
function tieTable(): readonly ModelSpec[] {
  return [
    { id: 'model-b', provider: 'p', capabilities: ['chat'], costPer1MTokens: 1.0 },
    { id: 'model-a', provider: 'p', capabilities: ['chat'], costPer1MTokens: 1.0 },
  ];
}

describe('routeRequest — cheapest-match selection', () => {
  test('no constraints returns the globally cheapest model', () => {
    const { model, costPer1MTokens } = routeRequest();
    expect(model.id).toBe('deepseek-v3');
    expect(costPer1MTokens).toBe(0.25);
  });

  test('empty capabilities array behaves like no filter', () => {
    const { model } = routeRequest({ capabilities: [] });
    expect(model.id).toBe('deepseek-v3');
  });

  test('returned costPer1MTokens equals the chosen model cost', () => {
    const { model, costPer1MTokens } = routeRequest({ capabilities: ['vision'] });
    expect(costPer1MTokens).toBe(model.costPer1MTokens);
  });

  test('chosen model actually satisfies every requested capability', () => {
    for (const caps of [['vision'], ['long-context'], ['reasoning', 'code']] as const) {
      const { model } = routeRequest({ capabilities: [...caps] });
      for (const c of caps) {
        expect(model.capabilities).toContain(c);
      }
    }
  });
});

describe('routeRequest — capability filter', () => {
  test('filters to cheapest model with a single required capability', () => {
    const { model } = routeRequest({ capabilities: ['vision'] });
    expect(model.id).toBe('gpt-4o-mini'); // 0.6, cheapest with vision
  });

  test('filters to cheapest model with long-context', () => {
    const { model, costPer1MTokens } = routeRequest({ capabilities: ['long-context'] });
    expect(model.id).toBe('llama-3.3-70b'); // 0.6 vs haiku 0.8
    expect(costPer1MTokens).toBe(0.6);
  });

  test('intersection of multiple required capabilities narrows candidates', () => {
    const { model } = routeRequest({ capabilities: ['reasoning', 'code'] });
    // deepseek 0.25 cheapest among reasoning+code models
    expect(model.id).toBe('deepseek-v3');
  });

  test('unknown capability throws UnknownCapabilityError', () => {
    expect(() => routeRequest({ capabilities: ['embedding'] })).toThrow(
      UnknownCapabilityError
    );
  });

  test('unknown capability among valid ones still throws', () => {
    try {
      routeRequest({ capabilities: ['chat', 'embedding'] });
      fail('expected UnknownCapabilityError');
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownCapabilityError);
      expect((e as RouterError).code).toBe('UNKNOWN_CAPABILITY');
    }
  });

  test('unknown capability error lists known capabilities', () => {
    try {
      routeRequest({ capabilities: ['quantum'] });
      fail('expected UnknownCapabilityError');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('quantum');
      expect(msg).toContain('chat');
    }
  });
});

describe('routeRequest — cost ceiling', () => {
  test('ceiling excludes models strictly above the price', () => {
    const { model } = routeRequest({ maxCostPer1MTokens: 0.5 });
    expect(model.id).toBe('deepseek-v3'); // only model <= 0.5
  });

  test('model priced exactly at the ceiling is allowed', () => {
    const { model, costPer1MTokens } = routeRequest({
      capabilities: ['long-context'],
      maxCostPer1MTokens: 0.6,
    });
    expect(model.id).toBe('llama-3.3-70b');
    expect(costPer1MTokens).toBe(0.6);
  });

  test('ceiling more restrictive than capability filter yields no route', () => {
    // cheapest vision model costs 0.6, ceiling is 0.5
    try {
      routeRequest({ capabilities: ['vision'], maxCostPer1MTokens: 0.5 });
      fail('expected NoRouteError');
    } catch (e) {
      expect(e).toBeInstanceOf(NoRouteError);
      expect((e as NoRouteError).reason).toBe('no-model-under-cost-ceiling');
    }
  });

  test('zero ceiling yields no route', () => {
    expect(() => routeRequest({ maxCostPer1MTokens: 0 })).toThrow(NoRouteError);
  });

  test('negative ceiling yields no route', () => {
    expect(() => routeRequest({ maxCostPer1MTokens: -1 })).toThrow(NoRouteError);
  });
});

describe('routeRequest — no match and edge cases', () => {
  test('no-match error carries NO_ROUTE code', () => {
    try {
      routeRequest({ capabilities: ['vision'], maxCostPer1MTokens: 0.1 });
      fail('expected NoRouteError');
    } catch (e) {
      expect((e as RouterError).code).toBe('NO_ROUTE');
    }
  });

  test('empty model table yields empty-model-table error', () => {
    try {
      routeRequest({}, []);
      fail('expected NoRouteError');
    } catch (e) {
      expect((e as NoRouteError).reason).toBe('empty-model-table');
    }
  });

  test('repeated calls are deterministic for the same input', () => {
    const a = routeRequest({ capabilities: ['vision'] });
    const b = routeRequest({ capabilities: ['vision'] });
    expect(a).toEqual(b);
    expect(a.model.id).toBe(b.model.id);
  });
});

describe('routeRequest — tie-breaking (deterministic)', () => {
  test('equal-cost models resolve to the earlier model in table order', () => {
    const { model } = routeRequest({}, tieTable());
    expect(model.id).toBe('model-b'); // first of the two 1.0-cost models
  });

  test('tie-break is stable across repeated calls', () => {
    const first = routeRequest({}, tieTable()).model.id;
    const second = routeRequest({}, tieTable()).model.id;
    expect(first).toBe(second);
  });

  test('a genuinely cheaper model beats earlier tie candidates', () => {
    const table: readonly ModelSpec[] = [
      { id: 'a', provider: 'p', capabilities: ['chat'], costPer1MTokens: 1.0 },
      { id: 'b', provider: 'p', capabilities: ['chat'], costPer1MTokens: 1.0 },
      { id: 'c', provider: 'p', capabilities: ['chat'], costPer1MTokens: 0.5 },
    ];
    const { model } = routeRequest({}, table);
    expect(model.id).toBe('c');
  });

  test('tie-breaking respects the capability filter first', () => {
    const table: readonly ModelSpec[] = [
      { id: 'cheap-no-cap', provider: 'p', capabilities: ['chat'], costPer1MTokens: 0.1 },
      { id: 'cap-a', provider: 'p', capabilities: ['chat', 'vision'], costPer1MTokens: 1.0 },
      { id: 'cap-b', provider: 'p', capabilities: ['chat', 'vision'], costPer1MTokens: 1.0 },
    ];
    const { model } = routeRequest({ capabilities: ['vision'] }, table);
    expect(model.id).toBe('cap-a'); // cheap-no-cap filtered out, tie -> table order
  });

  test('default MODEL_TABLE is exported and well-formed', () => {
    expect(MODEL_TABLE.length).toBeGreaterThanOrEqual(4);
    for (const m of MODEL_TABLE) {
      // A price is optional (the provider may publish none), but when it is
      // there it must be a real positive number — never 0, which would read
      // as "free" and win every cheapest comparison.
      if (m.costPer1MTokens !== undefined) {
        expect(m.costPer1MTokens).toBeGreaterThan(0);
      }
      expect(m.capabilities.length).toBeGreaterThan(0);
    }
  });
});