import {
  calibrateConfidence,
  classifyPrompt,
  DEFAULT_CLASSIFIER_CONFIG,
  estimateTokens,
} from '../src/classify';

describe('estimateTokens', () => {
  it('uses ~4 characters per token, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

describe('calibrateConfidence', () => {
  it('is 0.5 exactly on a boundary and rises with distance', () => {
    expect(calibrateConfidence(0, 12)).toBeCloseTo(0.5, 10);
    expect(calibrateConfidence(0.1, 12)).toBeGreaterThan(0.7);
    expect(calibrateConfidence(1, 12)).toBeGreaterThan(0.99);
  });

  it('is monotonic in the distance', () => {
    const a = calibrateConfidence(0.05, 12);
    const b = calibrateConfidence(0.15, 12);
    const c = calibrateConfidence(0.5, 12);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

describe('classifyPrompt — tiers', () => {
  it('classifies a trivial question as SIMPLE', () => {
    const result = classifyPrompt({ prompt: 'what is the capital of France?' });
    expect(result.tier).toBe('SIMPLE');
    expect(result.ambiguous).toBe(false);
    expect(result.score).toBeLessThan(0);
  });

  it('classifies explicit reasoning requests as REASONING with high confidence', () => {
    const result = classifyPrompt({
      prompt: 'Prove that the sum of two even numbers is even, step by step, formally.',
    });
    expect(result.tier).toBe('REASONING');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.signals.join(' ')).toContain('reasoning');
  });

  it('falls back to the default tier when the score sits on a boundary', () => {
    const result = classifyPrompt({
      prompt: 'Write a function that reverses a string in Python',
    });
    expect(result.ambiguous).toBe(true);
    expect(result.tier).toBe(DEFAULT_CLASSIFIER_CONFIG.ambiguousDefaultTier);
    expect(result.confidence).toBe(0.5);
    expect(result.reasoning).toContain('ambiguous');
  });

  it('forces COMPLEX for inputs above the token override', () => {
    const huge = 'x'.repeat(DEFAULT_CLASSIFIER_CONFIG.maxTokensForceComplex * 4 + 8);
    const result = classifyPrompt({ prompt: huge });
    expect(result.tier).toBe('COMPLEX');
    expect(result.confidence).toBe(0.95);
    expect(result.reasoning).toContain('exceeds');
  });

  it('raises a SIMPLE prompt to the structured-output minimum tier', () => {
    const plain = classifyPrompt({ prompt: 'hello' });
    expect(plain.tier).toBe('SIMPLE');

    const structured = classifyPrompt({ prompt: 'hello', requiresStructuredOutput: true });
    expect(structured.tier).toBe(DEFAULT_CLASSIFIER_CONFIG.structuredOutputMinTier);
    expect(structured.reasoning).toContain('structured output');
  });

  it('detects structured output from the system prompt too', () => {
    const result = classifyPrompt({
      prompt: 'hello',
      systemPrompt: 'Always answer with a JSON object.',
    });
    expect(result.tier).toBe('MEDIUM');
  });

  it('never downgrades a REASONING prompt for structured output', () => {
    const result = classifyPrompt({
      prompt: 'Prove this theorem formally, step by step.',
      requiresStructuredOutput: true,
    });
    expect(result.tier).toBe('REASONING');
  });
});

describe('classifyPrompt — dimensions and determinism', () => {
  it('scores code presence when the prompt contains code markers', () => {
    const result = classifyPrompt({ prompt: 'const x = 1; function f() { return x; }' });
    const code = result.dimensions.find((d) => d.name === 'codePresence');
    expect(code?.score).toBeGreaterThan(0);
  });

  it('scores agentic multi-step task prompts', () => {
    const result = classifyPrompt({
      prompt: 'Read the file, fix the bug, run npm install and verify it works.',
    });
    expect(result.agenticScore).toBe(1);
  });

  it('applies negative weight to simple indicators', () => {
    const result = classifyPrompt({ prompt: 'define recursion' });
    const simple = result.dimensions.find((d) => d.name === 'simpleIndicators');
    expect(simple?.score).toBe(-1);
  });

  it('keeps upstream’s dimension weights (they total 0.94, not 1.0)', () => {
    const total = Object.values(DEFAULT_CLASSIFIER_CONFIG.dimensionWeights).reduce(
      (a, b) => a + b,
      0
    );
    expect(total).toBeCloseTo(0.94, 10);
    // Every weighted dimension must have a weight, or its score is discarded.
    const scored = classifyPrompt({ prompt: 'hello' }).dimensions.map((d) => d.name);
    for (const name of scored) {
      expect(DEFAULT_CLASSIFIER_CONFIG.dimensionWeights[name]).toBeGreaterThan(0);
    }
  });

  it('is deterministic: same prompt, same classification', () => {
    const prompt = 'Design a distributed microservice architecture on kubernetes';
    const a = classifyPrompt({ prompt });
    const b = classifyPrompt({ prompt });
    expect(a.tier).toBe(b.tier);
    expect(a.score).toBe(b.score);
    expect(a.confidence).toBe(b.confidence);
  });

  it('bounds scanning cost by sampling long prompts', () => {
    // A marker far beyond the truncation window is still seen (head + tail
    // sampling keeps the end of the prompt), while the middle is skipped.
    const filler = 'a'.repeat(50_000);
    const result = classifyPrompt({ prompt: `${filler} prove this theorem formally` });
    expect(result.tier).toBe('REASONING');
  });
});
