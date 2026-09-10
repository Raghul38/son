/**
 * Typed errors thrown by the SDK client. Every error carries a stable
 * machine-readable `code` (HTTP_ERROR, PAYMENT_REJECTED, ...) plus specifics.
 */
/** Base class for all SDK client errors. */
export class RouterClientError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A 402 response whose body was not a usable x402 challenge (non-JSON, or
 * missing/empty scheme / token / payment fields). The client cannot proceed.
 */
export class MalformedChallengeError extends RouterClientError {
  constructor(reason: string) {
    super('MALFORMED_CHALLENGE', `Malformed x402 challenge from router: ${reason}`);
  }
}

/** An HTTP error status (anything other than 200 and not a 402 challenge). */
export class HttpError extends RouterClientError {
  constructor(
    readonly status: number,
    readonly statusText: string,
    /** Parsed JSON body when available; raw text otherwise; null when unreadable. */
    readonly body: unknown
  ) {
    super('HTTP_ERROR', `Router responded with HTTP ${status} ${statusText}`);
  }

  static async from(res: Response): Promise<HttpError> {
    const body = await readBody(res);
    return new HttpError(res.status, res.statusText, body);
  }
}

/**
 * The signed retry was rejected — the server answered with a FRESH 402
 * challenge (bad signature, wrong terms, mismatched nonce, expired challenge,
 * unbound on-ledger payment, ...). Inspect `challenge` / `body` for detail.
 */
export class PaymentRejectedError extends RouterClientError {
  constructor(
    /** The fresh challenge body, when the server's 402 was parseable. */
    readonly challenge: unknown,
    /** The raw response body that caused the rejection. */
    readonly body: unknown
  ) {
    super('PAYMENT_REJECTED', 'Router rejected the submitted payment and issued a fresh x402 challenge');
  }

  static async from(res: Response): Promise<PaymentRejectedError> {
    const body = await readBody(res);
    return new PaymentRejectedError(body, body);
  }
}

/** The caller-provided signer threw while signing the payment request. */
export class PaymentSigningError extends RouterClientError {
  constructor(readonly cause: unknown) {
    super('PAYMENT_SIGNING', 'The payment signer rejected the request');
  }
}

/** The request never completed: network failure, timeout, or an unreadable body. */
export class RequestFailedError extends RouterClientError {
  constructor(
    readonly cause: unknown,
    message: string
  ) {
    super('REQUEST_FAILED', message);
  }
}

/** Best-effort body extraction for error reporting (never throws). */
async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}