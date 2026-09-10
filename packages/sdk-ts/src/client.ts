/**
 * RouterClient — the x402 pay-and-retry chat client.
 *
 * Implements the complete x402 client flow against the XRP-Pay Router server:
 *
 *   1. POST the JSON request to `<routerUrl>/v1/chat`.
 *   2. On a 402, parse the x402 challenge from the response body.
 *   3. Hand the challenge's payment request to the CALLER-PROVIDED signer
 *      (the SDK never holds key material — see signer.ts).
 *   4. Retry the same request with the signed payment in the `X-PAYMENT`
 *      header — literal JSON, exactly the format packages/server/src/x402.ts
 *      parses (the server `JSON.parse`s the raw header; no base64 on this
 *      server).
 *   5. Return the final 200 body, or a typed error:
 *        - HttpError            — non-402 HTTP failure (first attempt or retry)
 *        - PaymentRejectedError — a SECOND 402 after the signed retry
 *        - MalformedChallengeError — 402 body was not a valid challenge
 *        - PaymentSigningError  — the caller's signer threw
 *        - RequestFailedError   — network failure / timeout / unreadable body
 *
 * All URLs and configuration come from constructor options (with env
 * fallbacks) — nothing mainnet-specific is hardcoded. `fetch` is injectable so
 * unit tests never need a live server.
 */
import { MalformedChallengeError, HttpError, PaymentRejectedError, PaymentSigningError, RequestFailedError } from './errors';
import { ChatOptions, PaymentSubmission, RouterChatRequest, RouterChatResponse, X402Challenge } from './types';
import { XrplSigner } from './signer';

/** Header carrying the signed payment envelope on the retry (per x402 spec). */
export const X_PAYMENT_HEADER = 'x-payment';
/** Header the server sets on 402 challenges (informational here). */
export const X402_SCHEME = 'x402';
/** Default chat endpoint path (the only route the SDK talks to). */
export const DEFAULT_CHAT_PATH = '/v1/chat';
/** Environment variable fallback for the router base URL. */
export const ROUTER_URL_ENV = 'XRPPAY_ROUTER_URL';

export interface RouterClientOptions {
  /**
   * Base URL of the router server, e.g. "http://localhost:8080".
   * Falls back to the XRPPAY_ROUTER_URL environment variable. Required.
   */
  routerUrl?: string;
  /** Caller-provided signer — owns all key material. Required. */
  signer: XrplSigner;
  /** Chat endpoint path (default "/v1/chat"). */
  path?: string;
  /** Injectable fetch for tests / custom runtimes (default: global fetch). */
  fetch?: typeof fetch;
  /** Hard deadline per HTTP request in ms (default: none). */
  timeoutMs?: number;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

export class RouterClient {
  private readonly baseUrl: string;
  private readonly chatPath: string;
  private readonly signer: XrplSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs?: number;
  private readonly headers: Record<string, string>;

  constructor(options: RouterClientOptions) {
    const envUrl =
      typeof process !== 'undefined' ? process.env?.[ROUTER_URL_ENV] : undefined;
    const rawUrl = options.routerUrl ?? envUrl ?? '';
    if (!rawUrl) {
      throw new Error(
        `RouterClient requires a routerUrl option (or the ${ROUTER_URL_ENV} environment variable).`
      );
    }
    if (!options.signer) {
      throw new Error('RouterClient requires a caller-provided signer (the SDK never holds private keys).');
    }
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.chatPath = options.path ?? DEFAULT_CHAT_PATH;
    this.signer = options.signer;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.headers = { 'Content-Type': 'application/json', ...options.headers };
  }

  /** Full URL of the chat endpoint. */
  chatUrl(): string {
    return `${this.baseUrl}${this.chatPath}`;
  }

  /**
   * Run the full x402 flow and return the paid chat response.
   * @throws RouterClientError subclasses — see the module doc comment.
   */
  async chat(
    request: RouterChatRequest,
    options?: ChatOptions
  ): Promise<RouterChatResponse> {
    const url = this.chatUrl();

    // 1. Unpaid request -> expect a 402 challenge (or an immediate error).
    const first = await this.send(url, request, undefined);
    if (first.status !== 402) {
      if (first.ok) {
        return (await this.parseOkBody(first)) as RouterChatResponse;
      }
      throw await HttpError.from(first);
    }

    // 2. Parse + validate the x402 challenge.
    const challenge = await parseChallenge(first);

    // 3. Sign with the caller-provided signer (SDK never sees key material).
    let signature: string;
    try {
      signature = await this.signer.signPaymentRequest(challenge.payment);
    } catch (err) {
      throw new PaymentSigningError(err);
    }

    // 4. Retry with the signed payment envelope in X-PAYMENT.
    const submission: PaymentSubmission = {
      nonce: challenge.token,
      signature,
      payment: challenge.payment,
      ...options?.paymentExtras,
    };
    const paid = await this.send(url, request, submission);
    if (paid.status === 402) {
      throw await PaymentRejectedError.from(paid);
    }
    if (!paid.ok) {
      throw await HttpError.from(paid);
    }
    return (await this.parseOkBody(paid)) as RouterChatResponse;
  }

  /** One POST to the chat endpoint. */
  private async send(
    url: string,
    request: RouterChatRequest,
    submission: PaymentSubmission | undefined
  ): Promise<Response> {
    const headers = { ...this.headers };
    if (submission) {
      headers[X_PAYMENT_HEADER] = JSON.stringify(submission);
    }
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        signal: this.timeoutMs ? AbortSignal.timeout(this.timeoutMs) : undefined,
      });
    } catch (err) {
      const reason =
        typeof err === 'object' && err !== null && 'name' in err && (err as { name?: unknown }).name === 'TimeoutError'
          ? `request timed out after ${this.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new RequestFailedError(err, `Router request failed: ${reason}`);
    }
  }

  /** A 2xx body must be JSON (the chat response contract). */
  private async parseOkBody(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new RequestFailedError(
        null,
        `Router responded HTTP ${res.status} with a non-JSON body`
      );
    }
  }
}

/** Parse + validate a 402 response body as an x402 challenge. */
async function parseChallenge(res: Response): Promise<X402Challenge> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new MalformedChallengeError('response body is not JSON');
  }
  if (typeof body !== 'object' || body === null) {
    throw new MalformedChallengeError('response body is not an object');
  }
  const b = body as Record<string, unknown>;
  if (b.scheme !== X402_SCHEME) {
    throw new MalformedChallengeError(`scheme is ${JSON.stringify(b.scheme)}, expected "${X402_SCHEME}"`);
  }
  if (typeof b.token !== 'string' || b.token.length === 0) {
    throw new MalformedChallengeError('token is missing or empty');
  }
  const p = b.payment;
  if (typeof p !== 'object' || p === null) {
    throw new MalformedChallengeError('payment request is missing or not an object');
  }
  const pr = p as Record<string, unknown>;
  for (const field of ['network', 'receiver', 'rewardDrops', 'nonce', 'expiresAt'] as const) {
    if (typeof pr[field] !== 'string' || (pr[field] as string).length === 0) {
      throw new MalformedChallengeError(`payment.${field} is missing or empty`);
    }
  }
  return { scheme: 'x402', token: b.token, payment: p as X402Challenge['payment'] };
}