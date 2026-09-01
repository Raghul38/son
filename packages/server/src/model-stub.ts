/**
 * Model invocation stub.
 *
 * TODO(real-llm): wire the actual LLM provider call here using the API key from
 * the LLM_API_KEY environment variable (never hardcode it). Currently returns
 * a deterministic placeholder so the payment-gated request path can be tested
 * end-to-end without network access.
 */

export interface ModelCallInput {
  /** Chosen model id (e.g. from router-core's routeRequest). */
  modelId: string;
  /** The chat messages from the request body. */
  messages: unknown[];
}

export interface ModelCallResult {
  /** The model's reply text. */
  content: string;
  /** Model id that produced the reply. */
  modelId: string;
}

export async function callModel(input: ModelCallInput): Promise<ModelCallResult> {
  // TODO(real-llm): read LLM_API_KEY from env and call the provider selected in
  // input.modelId. Do NOT hardcode keys or provider URLs here.
  return {
    modelId: input.modelId,
    content: `[stub] ${input.modelId} replied to ${input.messages.length} message(s). Real LLM call pending.`,
  };
}