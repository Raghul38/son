/**
 * POST /v1/chat handler.
 *
 * Runs BEHIND the x402 payment middleware, so by the time this handler runs the
 * request is already verified/paid. It asks router-core for a model, then calls
 * a real LLM provider when one is configured — currently DeepSeek
 * (packages/server/src/llm/deepseek.ts).
 *
 * Routing (router-core, pure — see packages/router-core):
 *   - ROUTING_STRATEGY=cheapest (default) keeps the original behavior: the
 *     cheapest model that has the requested capabilities and fits the cost
 *     ceiling.
 *   - ROUTING_STRATEGY=tiered classifies the prompt first (ClawRouter-derived
 *     classifier) and lets the tier add capability requirements, so a
 *     reasoning-heavy prompt cannot land on a chat-only model.
 *   Either way the strategy returns an ordered fallback chain; this handler
 *   walks it when a provider call fails with a retryable error.
 *
 * Provider dispatch, in plain words:
 *   - routed model's provider is "deepseek" AND LLM_API_KEY is set
 *       -> real DeepSeek API call (real completion + token usage).
 *   - anything else (no key configured, or openai/anthropic/openrouter)
 *       -> model stub fallback, flagged with `stub: true` so a caller can
 *          never mistake a placeholder for a real answer.
 *     (A later task will return 501 for unconfigured providers instead.)
 */
import { Request, Response } from 'express';
import {
  Capability,
  ModelSpec,
  MODEL_TABLE,
  NoRouteError,
  route,
  RoutingContext,
  RoutingDecision,
  UnknownCapabilityError,
} from '@xrppay/router-core';
import { callModel } from './model-stub';
import { callDeepSeek, LlmError } from './llm/deepseek';
import { ServerConfig } from './config';
import { Logger } from './logger';
import { PayRequest } from './x402';

export interface ChatRequest {
  messages?: unknown[];
  capabilities?: Capability[];
  maxCostPer1MTokens?: number;
  /** Caller declares it needs JSON/schema-shaped output (tiered strategy). */
  requiresStructuredOutput?: boolean;
}

/** Provider failures worth trying the next model in the chain for. */
const RETRYABLE_LLM_CODES: ReadonlySet<string> = new Set([
  'LLM_BUSY',
  'LLM_TIMEOUT',
  'LLM_PROVIDER_ERROR',
]);

/** Providers this server can actually call right now (adapter + credentials). */
function configuredProviders(config: ServerConfig): readonly string[] {
  return config.llmApiKey !== '' ? ['deepseek'] : [];
}

/** Providers present in the model table that this server cannot call. */
function unconfiguredProviders(config: ServerConfig): readonly string[] {
  const configured = new Set(configuredProviders(config));
  return Array.from(new Set(MODEL_TABLE.map((m) => m.provider))).filter(
    (p) => !configured.has(p)
  );
}

/** True when a real provider adapter can serve this model. */
function isRealProvider(model: ModelSpec, config: ServerConfig): boolean {
  return configuredProviders(config).includes(model.provider);
}

/**
 * Pull the prompt text out of OpenAI-style messages for the classifier.
 * Non-string content (tool calls, image parts) is ignored — the classifier
 * only needs text, and it must never throw on an odd body.
 */
function extractPrompt(messages: readonly unknown[]): {
  prompt: string;
  systemPrompt?: string;
} {
  const user: string[] = [];
  const system: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (typeof content !== 'string') continue;
    if (role === 'system') system.push(content);
    else user.push(content);
  }
  return {
    prompt: user.join('\n'),
    systemPrompt: system.length > 0 ? system.join('\n') : undefined,
  };
}

/** The additive `routing` block returned with a 200. */
function routingSummary(decision: RoutingDecision, attempts: number) {
  return {
    strategy: decision.strategy,
    ...(decision.tier !== undefined && { tier: decision.tier }),
    ...(decision.confidence !== undefined && {
      confidence: Number(decision.confidence.toFixed(3)),
    }),
    reasoning: decision.reasoning,
    chain: decision.chain.slice(0, 5).map((m) => m.id),
    attempts,
  };
}

/**
 * Call the provider adapter that owns this model. Today only DeepSeek has an
 * adapter; `isRealProvider` gates which models ever reach this function, so an
 * unknown provider here is a wiring bug rather than a runtime condition.
 */
function callProvider(
  model: ModelSpec,
  messages: readonly unknown[],
  config: ServerConfig,
  fetchImpl?: typeof fetch
) {
  if (model.provider !== 'deepseek') {
    throw new Error(`No provider adapter wired for "${model.provider}"`);
  }
  return callDeepSeek(
    { modelId: model.id, messages: [...messages] },
    {
      baseUrl: config.llmBaseUrl,
      apiKey: config.llmApiKey,
      timeoutMs: config.llmTimeoutMs,
      fetchImpl,
    }
  );
}

/**
 * @param fetchImpl Injectable fetch handed to the provider adapters so tests
 *   can exercise the fallback chain without touching the network.
 */
export function createChatHandler(config: ServerConfig, log: Logger, fetchImpl?: typeof fetch) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as ChatRequest;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const { prompt, systemPrompt } = extractPrompt(messages);

    const context: RoutingContext = {
      capabilities: body.capabilities,
      maxCostPer1MTokens: body.maxCostPer1MTokens,
      requiresStructuredOutput: body.requiresStructuredOutput,
      prompt,
      systemPrompt,
      // Opt-in: never route a paid request to a provider we cannot call.
      ...(config.routingSkipUnconfiguredProviders && {
        unavailableProviders: unconfiguredProviders(config),
      }),
    };

    let decision: RoutingDecision;
    try {
      decision = route(config.routingStrategy, context);
    } catch (err) {
      if (err instanceof UnknownCapabilityError) {
        res.status(400).json({ error: 'UNKNOWN_CAPABILITY', message: err.message });
        return;
      }
      if (err instanceof NoRouteError) {
        res.status(400).json({ error: 'NO_ROUTE', reason: err.reason, message: err.message });
        return;
      }
      throw err;
    }

    const model = decision.model;
    const useRealProvider = isRealProvider(model, config);

    log.info('routing', {
      model: model.id,
      costPer1MTokens: decision.costPer1MTokens,
      messages: messages.length,
      provider: useRealProvider ? model.provider : 'stub',
      strategy: decision.strategy,
      tier: decision.tier,
      paid: (req as PayRequest).payment?.verified === true,
    });

    // --- Real provider path: DeepSeek (OpenAI-compatible) ---
    // The chain is walked only for retryable failures, and only across models
    // a real adapter can serve — falling back to the stub would hand a paying
    // caller a placeholder instead of an answer.
    if (useRealProvider) {
      const chain = decision.chain
        .filter((m) => isRealProvider(m, config))
        .slice(0, Math.max(1, config.routingMaxAttempts));

      let attempts = 0;
      for (const candidate of chain) {
        attempts++;
        try {
          const result = await callProvider(candidate, messages, config, fetchImpl);
          res.status(200).json({
            model: candidate.id,
            modelProvider: candidate.provider,
            costPer1MTokens: candidate.costPer1MTokens,
            content: result.content,
            usage: result.usage,
            routing: routingSummary(decision, attempts),
          });
          return;
        } catch (err) {
          if (!(err instanceof LlmError)) throw err;
          // Never log or leak the API key — only the stable error code.
          log.warn('llm_error', { code: err.code, status: err.status, model: candidate.id });
          const isLast = attempts >= chain.length;
          if (!RETRYABLE_LLM_CODES.has(err.code) || isLast) {
            res.status(err.status).json({ error: err.code, message: err.message });
            return;
          }
          log.info('routing_fallback', { from: candidate.id, reason: err.code });
        }
      }
      return;
    }

    // --- Stub fallback: keeps local dev and tests working with zero config ---
    const result = await callModel({ modelId: model.id, messages });
    res.status(200).json({
      model: model.id,
      modelProvider: model.provider,
      costPer1MTokens: decision.costPer1MTokens,
      content: result.content,
      stub: true,
      routing: routingSummary(decision, 0),
    });
  };
}
