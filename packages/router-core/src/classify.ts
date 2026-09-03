/**
 * Rule-based prompt classifier: turns a prompt into a complexity TIER.
 *
 * Adapted from ClawRouter (BlockRunAI/ClawRouter), MIT (c) 2026 BlockRunAI —
 * commit 6bc5a30764cf, `dist/router/index.js` (the bundled, MIT-licensed
 * `@blockrun/router-core`). See THIRD_PARTY_NOTICES.md for the full license.
 *
 * What was kept from upstream: the weighted multi-dimension scoring model, the
 * per-dimension weights and score steps, the tier boundaries, the sigmoid
 * confidence calibration, the "two or more reasoning markers force REASONING"
 * short-circuit and the ambiguous -> default-tier behavior.
 *
 * What was changed for SonPay:
 *   - the keyword lists are the English subsets of upstream's multilingual
 *     lists (SonPay has no localization requirement, and a shorter list is
 *     auditable);
 *   - no BlockRun model catalog, pricing table or gateway concepts appear
 *     here — this module maps prompt -> tier and nothing else;
 *   - the module is pure and deterministic: no clock, no network, no I/O, so
 *     the same prompt always classifies to the same tier.
 */

/** Complexity tiers, cheapest-capable first. */
export type Tier = 'SIMPLE' | 'MEDIUM' | 'COMPLEX' | 'REASONING';

/** Rank used when a tier must be raised to a minimum (structured output). */
export const TIER_RANK: Readonly<Record<Tier, number>> = Object.freeze({
  SIMPLE: 0,
  MEDIUM: 1,
  COMPLEX: 2,
  REASONING: 3,
});

/** One scored signal contributing to the weighted complexity score. */
export interface DimensionScore {
  readonly name: string;
  readonly score: number;
  /** Human-readable explanation, or null when the dimension did not fire. */
  readonly signal: string | null;
}

export interface ClassifierConfig {
  /** Token counts below `simple` score -1, above `complex` score +1. */
  readonly tokenCountThresholds: { readonly simple: number; readonly complex: number };
  /** Longer prompts are sampled (head + tail) before keyword scanning. */
  readonly promptTruncationChars: number;
  readonly codeKeywords: readonly string[];
  readonly reasoningKeywords: readonly string[];
  readonly simpleKeywords: readonly string[];
  readonly technicalKeywords: readonly string[];
  readonly creativeKeywords: readonly string[];
  readonly imperativeVerbs: readonly string[];
  readonly constraintIndicators: readonly string[];
  readonly outputFormatKeywords: readonly string[];
  readonly referenceKeywords: readonly string[];
  readonly negationKeywords: readonly string[];
  readonly domainSpecificKeywords: readonly string[];
  readonly agenticTaskKeywords: readonly string[];
  /**
   * Per-dimension weights. Upstream's defaults sum to 0.94, not 1.0 (its
   * comment says otherwise); the weights are kept verbatim so tier boundaries
   * calibrated against them still hold.
   */
  readonly dimensionWeights: Readonly<Record<string, number>>;
  /** Tier boundaries on the weighted-score axis. */
  readonly tierBoundaries: {
    readonly simpleMedium: number;
    readonly mediumComplex: number;
    readonly complexReasoning: number;
  };
  /** Sigmoid steepness used to turn boundary distance into a confidence. */
  readonly confidenceSteepness: number;
  /** Below this confidence the classification is "ambiguous" (tier = null). */
  readonly confidenceThreshold: number;
  /** Prompts longer than this are forced to COMPLEX regardless of score. */
  readonly maxTokensForceComplex: number;
  /** Tier used when the classification is ambiguous. */
  readonly ambiguousDefaultTier: Tier;
  /** Requests asking for structured output are raised to at least this tier. */
  readonly structuredOutputMinTier: Tier;
}

/** Upstream's defaults, with English-only keyword lists (see file header). */
export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = Object.freeze({
  tokenCountThresholds: { simple: 50, complex: 500 },
  promptTruncationChars: 500,
  codeKeywords: [
    'function', 'class', 'import', 'def', 'SELECT', 'async', 'await',
    'const', 'let', 'var', 'return', '```',
  ],
  reasoningKeywords: [
    'prove', 'theorem', 'derive', 'step by step', 'chain of thought',
    'formally', 'mathematical', 'proof', 'logically',
  ],
  simpleKeywords: [
    'what is', 'define', 'translate', 'hello', 'yes or no', 'capital of',
    'how old', 'who is', 'when was',
  ],
  technicalKeywords: [
    'algorithm', 'optimize', 'architecture', 'distributed', 'kubernetes',
    'microservice', 'database', 'infrastructure',
  ],
  creativeKeywords: [
    'story', 'poem', 'compose', 'brainstorm', 'creative', 'imagine', 'write a',
  ],
  imperativeVerbs: [
    'build', 'create', 'implement', 'design', 'develop', 'construct',
    'generate', 'deploy', 'configure', 'set up',
  ],
  constraintIndicators: [
    'under', 'at most', 'at least', 'within', 'no more than', 'o(',
    'maximum', 'minimum', 'limit', 'budget',
  ],
  outputFormatKeywords: [
    'json', 'yaml', 'xml', 'table', 'csv', 'markdown', 'schema',
    'format as', 'structured',
  ],
  referenceKeywords: [
    'above', 'below', 'previous', 'following', 'the docs', 'the api',
    'the code', 'earlier', 'attached',
  ],
  negationKeywords: [
    "don't", 'do not', 'avoid', 'never', 'without', 'except', 'exclude',
    'no longer',
  ],
  domainSpecificKeywords: [
    'quantum', 'fpga', 'vlsi', 'risc-v', 'asic', 'photonics', 'genomics',
    'proteomics', 'topological', 'homomorphic', 'zero-knowledge',
    'lattice-based',
  ],
  agenticTaskKeywords: [
    'read file', 'read the file', 'look at', 'check the', 'open the', 'edit',
    'modify', 'update the', 'change the', 'write to', 'create file', 'execute',
    'deploy', 'install', 'npm', 'pip', 'compile', 'after that', 'and also',
    'once done', 'step 1', 'step 2', 'fix', 'debug', 'until it works',
    'keep trying', 'iterate', 'make sure', 'verify', 'confirm',
  ],
  dimensionWeights: {
    tokenCount: 0.08,
    codePresence: 0.15,
    reasoningMarkers: 0.18,
    technicalTerms: 0.1,
    creativeMarkers: 0.05,
    simpleIndicators: 0.02,
    multiStepPatterns: 0.12,
    questionComplexity: 0.05,
    imperativeVerbs: 0.03,
    constraintCount: 0.04,
    outputFormat: 0.03,
    referenceComplexity: 0.02,
    negationComplexity: 0.01,
    domainSpecificity: 0.02,
    agenticTask: 0.04,
  },
  tierBoundaries: { simpleMedium: 0, mediumComplex: 0.3, complexReasoning: 0.5 },
  confidenceSteepness: 12,
  confidenceThreshold: 0.7,
  maxTokensForceComplex: 100_000,
  ambiguousDefaultTier: 'MEDIUM',
  structuredOutputMinTier: 'MEDIUM',
});

/** Result of classifying one prompt. */
export interface Classification {
  /** Weighted complexity score (roughly -1..+1). */
  readonly score: number;
  /** Chosen tier — never null; `ambiguous` says whether it was a fallback. */
  readonly tier: Tier;
  /** Sigmoid-calibrated confidence in [0, 1]. */
  readonly confidence: number;
  /** True when confidence was below the threshold and the default tier was used. */
  readonly ambiguous: boolean;
  /** Human-readable signals that fired, for logging/debugging. */
  readonly signals: readonly string[];
  /** 0..1 score for "this looks like a multi-step agentic task". */
  readonly agenticScore: number;
  /** Every dimension's raw contribution (unweighted). */
  readonly dimensions: readonly DimensionScore[];
  /** Short explanation of how the tier was reached. */
  readonly reasoning: string;
}

/** Inputs to a classification. All optional except the prompt. */
export interface ClassifyInput {
  readonly prompt: string;
  readonly systemPrompt?: string;
  /**
   * Caller-declared "the response must be JSON/schema-shaped". Upstream also
   * sniffs the system prompt for json/structured/schema; we keep both.
   */
  readonly requiresStructuredOutput?: boolean;
}

/** Cheap token estimate: ~4 characters per token (upstream's heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Sigmoid: distance from a tier boundary -> confidence in (0, 1). */
export function calibrateConfidence(distance: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * distance));
}

function scoreTokenCount(
  estimatedTokens: number,
  thresholds: ClassifierConfig['tokenCountThresholds']
): DimensionScore {
  if (estimatedTokens < thresholds.simple) {
    return { name: 'tokenCount', score: -1, signal: `short (${estimatedTokens} tokens)` };
  }
  if (estimatedTokens > thresholds.complex) {
    return { name: 'tokenCount', score: 1, signal: `long (${estimatedTokens} tokens)` };
  }
  return { name: 'tokenCount', score: 0, signal: null };
}

function scoreKeywordMatch(
  text: string,
  keywords: readonly string[],
  name: string,
  label: string,
  thresholds: { low: number; high: number },
  scores: { none: number; low: number; high: number }
): DimensionScore {
  const matches = keywords.filter((kw) => text.includes(kw.toLowerCase()));
  if (matches.length >= thresholds.high) {
    return { name, score: scores.high, signal: `${label} (${matches.slice(0, 3).join(', ')})` };
  }
  if (matches.length >= thresholds.low) {
    return { name, score: scores.low, signal: `${label} (${matches.slice(0, 3).join(', ')})` };
  }
  return { name, score: scores.none, signal: null };
}

function scoreMultiStep(text: string): DimensionScore {
  const patterns = [/first.*then/i, /step \d/i, /\d\.\s/];
  if (patterns.some((p) => p.test(text))) {
    return { name: 'multiStepPatterns', score: 0.5, signal: 'multi-step' };
  }
  return { name: 'multiStepPatterns', score: 0, signal: null };
}

function scoreQuestionComplexity(prompt: string): DimensionScore {
  const count = (prompt.match(/\?/g) ?? []).length;
  if (count > 3) {
    return { name: 'questionComplexity', score: 0.5, signal: `${count} questions` };
  }
  return { name: 'questionComplexity', score: 0, signal: null };
}

function scoreAgenticTask(
  text: string,
  keywords: readonly string[]
): { dimension: DimensionScore; agenticScore: number } {
  const hits: string[] = [];
  let matchCount = 0;
  for (const kw of keywords) {
    if (text.includes(kw.toLowerCase())) {
      matchCount++;
      if (hits.length < 3) hits.push(kw);
    }
  }
  const label = (score: number, tag: string) => ({
    dimension: { name: 'agenticTask', score, signal: `${tag} (${hits.join(', ')})` },
    agenticScore: score,
  });
  if (matchCount >= 4) return label(1, 'agentic');
  if (matchCount >= 3) return label(0.6, 'agentic');
  if (matchCount >= 1) return label(0.2, 'agentic-light');
  return { dimension: { name: 'agenticTask', score: 0, signal: null }, agenticScore: 0 };
}

/** Sample long text head+tail so keyword scanning cost stays bounded. */
function sample(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const prefix = Math.ceil(limit / 2);
  return `${value.slice(0, prefix)}\n${value.slice(-(limit - prefix))}`;
}

/**
 * Classify a prompt into a complexity tier.
 *
 * Deterministic: same input -> same output, always.
 */
export function classifyPrompt(
  input: ClassifyInput,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG
): Classification {
  const { prompt, systemPrompt } = input;
  const estimatedTokens = estimateTokens(`${systemPrompt ?? ''} ${prompt}`);

  const scanLimit = Math.max(1, Math.min(8000, config.promptTruncationChars));
  const scannedPrompt = sample(prompt, scanLimit);
  const scannedSystemPrompt = systemPrompt ? sample(systemPrompt, scanLimit) : undefined;
  const userText = scannedPrompt.toLowerCase();

  const dimensions: DimensionScore[] = [
    scoreTokenCount(estimatedTokens, config.tokenCountThresholds),
    scoreKeywordMatch(userText, config.codeKeywords, 'codePresence', 'code',
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.reasoningKeywords, 'reasoningMarkers', 'reasoning',
      { low: 1, high: 2 }, { none: 0, low: 0.7, high: 1 }),
    scoreKeywordMatch(userText, config.technicalKeywords, 'technicalTerms', 'technical',
      { low: 2, high: 4 }, { none: 0, low: 0.5, high: 1 }),
    scoreKeywordMatch(userText, config.creativeKeywords, 'creativeMarkers', 'creative',
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.7 }),
    // Simple indicators pull the score DOWN (negative weight contribution).
    scoreKeywordMatch(userText, config.simpleKeywords, 'simpleIndicators', 'simple',
      { low: 1, high: 2 }, { none: 0, low: -1, high: -1 }),
    scoreMultiStep(userText),
    scoreQuestionComplexity(scannedPrompt),
    scoreKeywordMatch(userText, config.imperativeVerbs, 'imperativeVerbs', 'imperative',
      { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.constraintIndicators, 'constraintCount', 'constraints',
      { low: 1, high: 3 }, { none: 0, low: 0.3, high: 0.7 }),
    scoreKeywordMatch(userText, config.outputFormatKeywords, 'outputFormat', 'format',
      { low: 1, high: 2 }, { none: 0, low: 0.4, high: 0.7 }),
    scoreKeywordMatch(userText, config.referenceKeywords, 'referenceComplexity', 'references',
      { low: 1, high: 2 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.negationKeywords, 'negationComplexity', 'negation',
      { low: 2, high: 3 }, { none: 0, low: 0.3, high: 0.5 }),
    scoreKeywordMatch(userText, config.domainSpecificKeywords, 'domainSpecificity', 'domain-specific',
      { low: 1, high: 2 }, { none: 0, low: 0.5, high: 0.8 }),
  ];

  const agentic = scoreAgenticTask(userText, config.agenticTaskKeywords);
  dimensions.push(agentic.dimension);

  const signals = dimensions
    .map((d) => d.signal)
    .filter((s): s is string => s !== null);

  let score = 0;
  for (const d of dimensions) {
    score += d.score * (config.dimensionWeights[d.name] ?? 0);
  }

  const base = {
    score,
    signals,
    agenticScore: agentic.agenticScore,
    dimensions,
  };
  const scoreSummary = `score=${score.toFixed(2)}${signals.length > 0 ? ` | ${signals.join(', ')}` : ''}`;

  // Long inputs are a hard override: a huge prompt is expensive to get wrong.
  if (estimatedTokens > config.maxTokensForceComplex) {
    return {
      ...base,
      tier: 'COMPLEX',
      confidence: 0.95,
      ambiguous: false,
      reasoning: `input exceeds ${config.maxTokensForceComplex} tokens`,
    };
  }

  const structured =
    input.requiresStructuredOutput === true ||
    (scannedSystemPrompt ? /json|structured|schema/i.test(scannedSystemPrompt) : false);

  const upgradeForStructuredOutput = (c: Classification): Classification => {
    if (!structured) return c;
    const min = config.structuredOutputMinTier;
    if (TIER_RANK[c.tier] >= TIER_RANK[min]) return c;
    return {
      ...c,
      tier: min,
      reasoning: `${c.reasoning} | upgraded to ${min} (structured output)`,
    };
  };

  // Explicit reasoning markers short-circuit the boundary logic: two or more
  // of them mean the user asked for reasoning, whatever the weighted score is.
  const reasoningMatches = config.reasoningKeywords.filter((kw) =>
    userText.includes(kw.toLowerCase())
  );
  if (reasoningMatches.length >= 2) {
    return upgradeForStructuredOutput({
      ...base,
      tier: 'REASONING',
      confidence: Math.max(
        calibrateConfidence(Math.max(score, 0.3), config.confidenceSteepness),
        0.85
      ),
      ambiguous: false,
      reasoning: `${scoreSummary} | reasoning markers: ${reasoningMatches.slice(0, 3).join(', ')}`,
    });
  }

  const { simpleMedium, mediumComplex, complexReasoning } = config.tierBoundaries;
  let tier: Tier;
  let distance: number;
  if (score < simpleMedium) {
    tier = 'SIMPLE';
    distance = simpleMedium - score;
  } else if (score < mediumComplex) {
    tier = 'MEDIUM';
    distance = Math.min(score - simpleMedium, mediumComplex - score);
  } else if (score < complexReasoning) {
    tier = 'COMPLEX';
    distance = Math.min(score - mediumComplex, complexReasoning - score);
  } else {
    tier = 'REASONING';
    distance = score - complexReasoning;
  }

  const confidence = calibrateConfidence(distance, config.confidenceSteepness);
  if (confidence < config.confidenceThreshold) {
    // Too close to a boundary to trust: fall back to the default tier rather
    // than gambling on an expensive (or too-weak) model.
    return upgradeForStructuredOutput({
      ...base,
      tier: config.ambiguousDefaultTier,
      confidence: 0.5,
      ambiguous: true,
      reasoning: `${scoreSummary} | ambiguous -> default: ${config.ambiguousDefaultTier}`,
    });
  }

  return upgradeForStructuredOutput({
    ...base,
    tier,
    confidence,
    ambiguous: false,
    reasoning: scoreSummary,
  });
}
