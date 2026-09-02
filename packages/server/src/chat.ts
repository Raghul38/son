/**
 * POST /v1/chat handler.
 *
 * Runs BEHIND the x402 payment middleware, so by the time this handler runs the
 * request is already verified/paid. It routes the request to the cheapest
 * capable model via router-core, then calls a real LLM provider when one is
 * configured — currently DeepSeek (packages/server/src/llm/deepseek.ts).
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
import { routeRequest, NoRouteError, Capability, UnknownCapabilityError } from '@xrppay/router-core';
import { callModel } from './model-stub';
import { callDeepSeek, LlmError } from './llm/deepseek';
import { ServerConfig } from './config';
import { Logger } from './logger';
import { PayRequest } from './x402';

export interface ChatRequest {
  messages?: unknown[];
  capabilities?: Capability[];
  maxCostPer1MTokens?: number;
}

export function createChatHandler(config: ServerConfig, log: Logger) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as ChatRequest;
    const messages = Array.isArray(body.messages) ? body.messages : [];

    let route;
    try {
      route = routeRequest({
        capabilities: body.capabilities,
        maxCostPer1MTokens: body.maxCostPer1MTokens,
      });
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

    const model = route.model;
    const useDeepSeek = model.provider === 'deepseek' && config.llmApiKey !== '';

    log.info('routing', {
      model: model.id,
      costPer1MTokens: route.costPer1MTokens,
      messages: messages.length,
      provider: useDeepSeek ? 'deepseek' : 'stub',
      paid: (req as PayRequest).payment?.verified === true,
    });

    // --- Real provider path: DeepSeek (OpenAI-compatible) ---
    if (useDeepSeek) {
      try {
        const result = await callDeepSeek(
          { modelId: model.id, messages },
          {
            baseUrl: config.llmBaseUrl,
            apiKey: config.llmApiKey,
            timeoutMs: config.llmTimeoutMs,
          }
        );
        res.status(200).json({
          model: model.id,
          modelProvider: model.provider,
          costPer1MTokens: route.costPer1MTokens,
          content: result.content,
          usage: result.usage,
        });
      } catch (err) {
        if (err instanceof LlmError) {
          // Never log or leak the API key — only the stable error code.
          log.warn('llm_error', { code: err.code, status: err.status });
          res.status(err.status).json({ error: err.code, message: err.message });
        } else {
          throw err;
        }
      }
      return;
    }

    // --- Stub fallback: keeps local dev and tests working with zero config ---
    const result = await callModel({ modelId: model.id, messages });
    res.status(200).json({
      model: model.id,
      modelProvider: model.provider,
      costPer1MTokens: route.costPer1MTokens,
      content: result.content,
      stub: true,
    });
  };
}
