/**
 * POST /v1/chat handler.
 *
 * Runs BEHIND the x402 payment middleware, so by the time this handler runs the
 * request is already verified/paid. It routes the request to the cheapest
 * capable model via router-core, then (for now) invokes the model stub.
 */
import { Request, Response } from 'express';
import { routeRequest, NoRouteError, Capability, UnknownCapabilityError } from '@xrppay/router-core';
import { callModel } from './model-stub';
import { Logger } from './logger';
import { PayRequest } from './x402';

export interface ChatRequest {
  messages?: unknown[];
  capabilities?: Capability[];
  maxCostPer1MTokens?: number;
}

export function createChatHandler(log: Logger) {
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

    log.info('routing', {
      model: route.model.id,
      costPer1MTokens: route.costPer1MTokens,
      messages: messages.length,
      paid: (req as PayRequest).payment?.verified === true,
    });

    const result = await callModel({ modelId: route.model.id, messages });
    res.status(200).json({
      model: route.model.id,
      modelProvider: route.model.provider,
      costPer1MTokens: route.costPer1MTokens,
      content: result.content,
    });
  };
}