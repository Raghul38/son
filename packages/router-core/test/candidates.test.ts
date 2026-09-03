import {
  applyPreference,
  CAPACITY_HEADROOM,
  rankByCost,
  selectCandidates,
} from '../src/candidates';
import { NoRouteError, UnknownCapabilityError } from '../src/errors';
import { ModelSpec } from '../src/models';

const TABLE: readonly ModelSpec[] = [
  {
    id: 'cheap',
    provider: 'alpha',
    capabilities: ['chat', 'json'],
    costPer1MTokens: 0.1,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
  },
  {
    id: 'mid',
    provider: 'beta',
    capabilities: ['chat', 'json', 'reasoning'],
    costPer1MTokens: 1,
    contextWindow: 128_000,
  },
  {
    id: 'rich',
    provider: 'gamma',
    capabilities: ['chat', 'json', 'reasoning', 'vision', 'code'],
    costPer1MTokens: 5,
  },
];

describe('selectCandidates — ordering', () => {
  it('returns every model cheapest-first', () => {
    expect(selectCandidates({}, TABLE).map((m) => m.id)).toEqual(['cheap', 'mid', 'rich']);
  });

  it('keeps table order for equal-cost models', () => {
    const tied: readonly ModelSpec[] = [
      { id: 'first', provider: 'a', capabilities: ['chat'], costPer1MTokens: 1 },
      { id: 'second', provider: 'b', capabilities: ['chat'], costPer1MTokens: 1 },
    ];
    expect(selectCandidates({}, tied).map((m) => m.id)).toEqual(['first', 'second']);
    expect(rankByCost([...tied].reverse()).map((m) => m.id)).toEqual(['second', 'first']);
  });
});

describe('selectCandidates — filters', () => {
  it('filters by capability (AND)', () => {
    expect(selectCandidates({ capabilities: ['reasoning'] }, TABLE).map((m) => m.id)).toEqual([
      'mid',
      'rich',
    ]);
    expect(
      selectCandidates({ capabilities: ['reasoning', 'vision'] }, TABLE).map((m) => m.id)
    ).toEqual(['rich']);
  });

  it('rejects an unknown capability before filtering', () => {
    expect(() => selectCandidates({ capabilities: ['telepathy' as never] }, TABLE)).toThrow(
      UnknownCapabilityError
    );
  });

  it('applies the cost ceiling inclusively', () => {
    expect(selectCandidates({ maxCostPer1MTokens: 1 }, TABLE).map((m) => m.id)).toEqual([
      'cheap',
      'mid',
    ]);
  });

  it('filters out excluded model ids', () => {
    expect(selectCandidates({ excludeModelIds: ['cheap'] }, TABLE).map((m) => m.id)).toEqual([
      'mid',
      'rich',
    ]);
  });

  it('filters out unavailable providers', () => {
    expect(
      selectCandidates({ unavailableProviders: ['alpha', 'gamma'] }, TABLE).map((m) => m.id)
    ).toEqual(['mid']);
  });

  it('filters by context capacity with head-room, keeping unknown limits', () => {
    // 8k window cannot hold 7900 tokens once the 1.1x head-room is applied.
    const needed = Math.floor(8_000 / CAPACITY_HEADROOM) + 100;
    const ids = selectCandidates({ estimatedInputTokens: needed }, TABLE).map((m) => m.id);
    expect(ids).toEqual(['mid', 'rich']); // "rich" has no published window -> kept
  });

  it('filters by max output tokens when the model publishes one', () => {
    const ids = selectCandidates(
      { estimatedInputTokens: 100, requestedOutputTokens: 4_000 },
      TABLE
    ).map((m) => m.id);
    expect(ids).toEqual(['mid', 'rich']);
  });
});

describe('selectCandidates — no-route reasons', () => {
  it('reports an empty table', () => {
    expect(() => selectCandidates({}, [])).toThrow(new NoRouteError('empty-model-table'));
  });

  it('reports a capability filter that matched nothing', () => {
    const table: readonly ModelSpec[] = [
      { id: 'a', provider: 'a', capabilities: ['chat', 'vision'], costPer1MTokens: 1 },
      { id: 'b', provider: 'b', capabilities: ['chat', 'reasoning'], costPer1MTokens: 2 },
    ];
    try {
      selectCandidates({ capabilities: ['vision', 'reasoning'] }, table);
      throw new Error('expected NoRouteError');
    } catch (err) {
      expect((err as NoRouteError).reason).toBe('no-model-matches');
    }
  });

  it('reports a cost ceiling that matched nothing', () => {
    try {
      selectCandidates({ maxCostPer1MTokens: 0.01 }, TABLE);
      throw new Error('expected NoRouteError');
    } catch (err) {
      expect((err as NoRouteError).reason).toBe('no-model-under-cost-ceiling');
    }
  });

  it('reports an exclude list that removed everything', () => {
    try {
      selectCandidates({ excludeModelIds: ['cheap', 'mid', 'rich'] }, TABLE);
      throw new Error('expected NoRouteError');
    } catch (err) {
      expect((err as NoRouteError).reason).toBe('all-models-excluded');
    }
  });

  it('reports when every provider is unavailable', () => {
    try {
      selectCandidates({ unavailableProviders: ['alpha', 'beta', 'gamma'] }, TABLE);
      throw new Error('expected NoRouteError');
    } catch (err) {
      expect((err as NoRouteError).reason).toBe('no-available-provider');
    }
  });

  it('reports when nothing has enough context', () => {
    const small: readonly ModelSpec[] = [
      {
        id: 'tiny',
        provider: 'a',
        capabilities: ['chat'],
        costPer1MTokens: 1,
        contextWindow: 1_000,
      },
    ];
    try {
      selectCandidates({ estimatedInputTokens: 50_000 }, small);
      throw new Error('expected NoRouteError');
    } catch (err) {
      expect((err as NoRouteError).reason).toBe('no-model-with-enough-context');
    }
  });

  it('fails closed rather than reverting to an unfiltered list', () => {
    // ClawRouter reverts to the unfiltered candidates when a soft filter
    // empties the list. SonPay is paid-for: it must not silently serve a
    // model the caller ruled out.
    expect(() => selectCandidates({ excludeModelIds: ['cheap', 'mid', 'rich'] }, TABLE)).toThrow(
      NoRouteError
    );
  });
});

describe('applyPreference', () => {
  const ranked = rankByCost(TABLE);

  it('moves preferred models to the front in the order given', () => {
    expect(applyPreference(ranked, ['rich', 'mid']).map((m) => m.id)).toEqual([
      'rich',
      'mid',
      'cheap',
    ]);
  });

  it('ignores preferred ids that are not candidates', () => {
    expect(applyPreference(ranked, ['nonexistent']).map((m) => m.id)).toEqual([
      'cheap',
      'mid',
      'rich',
    ]);
  });

  it('is a no-op without preferences', () => {
    expect(applyPreference(ranked, [])).toBe(ranked);
  });
});
