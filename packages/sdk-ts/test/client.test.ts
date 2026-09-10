/**
 * RouterClient unit tests — the full x402 client flow with a mocked fetch
 * (no live server needed).
 *
 * Covers:
 *   - 402 -> sign -> retry -> 200 end to end (exact X-PAYMENT header format)
 *   - malformed challenge bodies (non-JSON, missing payment)
 *   - signer rejection (typed PaymentSigningError, no retry sent)
 *   - non-402 HTTP failures (first attempt and after a 402)
 *   - a SECOND 402 after the signed retry (typed PaymentRejectedError)
 *   - network failures and non-JSON success bodies
 *   - XrplWalletSigner adapter (duck-typed xrpl.js Wallet)
 *   - constructor validation (no key material ever required)
 */
import { RouterClient, X_PAYMENT_HEADER } from '../src/client';
import { XrplWalletSigner, XrplSigner } from '../src/signer';
import { PaymentRequest, RouterChatResponse, X402Challenge } from '../src/types';
import {
  HttpError,
  MalformedChallengeError,
  PaymentRejectedError,
  PaymentSigningError,
  RequestFailedError,
} from '../src/errors';

const BASE_URL = 'http://router.local:8080';
const CHAT_URL = `${BASE_URL}/v1/chat`;

/** A realistic challenge matching what packages/server issues. */
function makeChallenge(overrides: Partial<X402Challenge> = {}): X402Challenge {
  const payment: PaymentRequest = {
    network: 'xrpl:1', // testnet — never mainnet in tests
    receiver: 'rMOCKRECEIVERaddress00000000000000000',
    rewardDrops: '1000000',
    nonce: 'nonce-1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  return { scheme: 'x402', token: payment.nonce, payment, ...overrides };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fakeSigner(signature = 'signature-abc'): XrplSigner & { signPaymentRequest: jest.Mock } {
  return {
    address: 'rPAYERaddress00000000000000000000000',
    signPaymentRequest: jest.fn(async (_req: PaymentRequest) => signature),
  };
}

/** Capture every fetch call for assertions. */
function mockFetch(responses: Response[]): { fetchMock: jest.Mock; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('mock fetch exhausted');
    return next;
  });
  return { fetchMock, calls };
}

function headerOf(call: { init: RequestInit }, name: string): string | undefined {
  return (call.init.headers as Record<string, string>)[name];
}

describe('RouterClient — x402 client flow (mocked fetch)', () => {
  const requestPayload = {
    messages: [{ role: 'user', content: 'hi' }],
    capabilities: ['chat'],
  };

  it('runs the full 402 -> sign -> retry -> 200 cycle', async () => {
    const okBody: RouterChatResponse = {
      model: 'deepseek-v3',
      modelProvider: 'deepseek',
      costPer1MTokens: 0.25,
      content: 'hello from deepseek-v3',
    };
    const { fetchMock, calls } = mockFetch([
      jsonResponse(402, makeChallenge(), { 'www-authenticate': 'x402' }),
      jsonResponse(200, okBody),
    ]);
    const signer = fakeSigner('signature-abc');
    const client = new RouterClient({
      routerUrl: BASE_URL,
      signer,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(client.chat(requestPayload)).resolves.toEqual(okBody);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 1. Unpaid POST — no X-PAYMENT header, JSON body sent verbatim.
    expect(calls[0].url).toBe(CHAT_URL);
    expect(calls[0].init.method).toBe('POST');
    expect(headerOf(calls[0], X_PAYMENT_HEADER)).toBeUndefined();
    expect(JSON.parse(calls[0].init.body as string)).toEqual(requestPayload);
    // Signer was handed the challenge's payment request.
    expect(signer.signPaymentRequest).toHaveBeenCalledTimes(1);
    expect(signer.signPaymentRequest).toHaveBeenCalledWith(makeChallenge().payment);
    // 2. Retry — exact server format: { nonce, signature, payment } as
    //    literal JSON (that is what packages/server/src/x402.ts parses).
    expect(calls[1].url).toBe(CHAT_URL);
    expect(JSON.parse(calls[1].init.body as string)).toEqual(requestPayload);
    const sent = JSON.parse(headerOf(calls[1], X_PAYMENT_HEADER) as string);
    expect(sent).toEqual({
      nonce: 'nonce-1',
      signature: 'signature-abc',
      payment: makeChallenge().payment,
    });
  });

  it('a 200 on the first attempt is returned directly (no signing needed)', async () => {
    const okBody = { model: 'gpt-4o-mini', content: 'paid' };
    const { fetchMock } = mockFetch([jsonResponse(200, okBody)]);
    const signer = fakeSigner();
    const client = new RouterClient({ routerUrl: BASE_URL, signer, fetch: fetchMock as unknown as typeof fetch });

    await expect(client.chat({ messages: [] })).resolves.toEqual(okBody);
    expect(signer.signPaymentRequest).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws MalformedChallengeError when the 402 body is not a valid challenge', async () => {
    const cases: unknown[] = [
      { scheme: 'x402', token: 't' }, // missing payment
      { scheme: 'x402', token: 't', payment: { nonce: '' } }, // empty payment nonce
      { token: 't', payment: makeChallenge().payment }, // wrong scheme
      'not-an-object',
    ];
    for (const badBody of cases) {
      const { fetchMock } = mockFetch([jsonResponse(402, badBody)]);
      const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });
      const err = await client.chat({ messages: [] }).catch((e) => e);
      expect(err).toBeInstanceOf(MalformedChallengeError);
      expect((err as MalformedChallengeError).code).toBe('MALFORMED_CHALLENGE');
    }
  });

  it('throws MalformedChallengeError when the 402 response body is not JSON', async () => {
    const nonJson = new Response('oops not json', {
      status: 402,
      headers: { 'Content-Type': 'text/plain' },
    });
    const { fetchMock } = mockFetch([nonJson]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.chat({ messages: [] })).rejects.toBeInstanceOf(MalformedChallengeError);
  });

  it('wraps a rejecting signer in PaymentSigningError and never retries', async () => {
    const signer = fakeSigner();
    signer.signPaymentRequest.mockRejectedValueOnce(new Error('wallet locked'));
    const { fetchMock, calls } = mockFetch([jsonResponse(402, makeChallenge())]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer, fetch: fetchMock as unknown as typeof fetch });

    const err = await client.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentSigningError);
    expect((err as PaymentSigningError).code).toBe('PAYMENT_SIGNING');
    expect((err as PaymentSigningError).cause).toEqual(new Error('wallet locked'));
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry without a signature
    expect(calls[0].init.headers).not.toHaveProperty(X_PAYMENT_HEADER);
  });

  it('throws HttpError for a non-402 HTTP failure on the first attempt', async () => {
    const { fetchMock } = mockFetch([
      jsonResponse(400, { error: 'UNKNOWN_CAPABILITY', message: 'nope' }),
    ]);
    const signer = fakeSigner();
    const client = new RouterClient({ routerUrl: BASE_URL, signer, fetch: fetchMock as unknown as typeof fetch });

    const err = await client.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
    expect((err as HttpError).code).toBe('HTTP_ERROR');
    expect((err as HttpError).body).toEqual({ error: 'UNKNOWN_CAPABILITY', message: 'nope' });
    expect(signer.signPaymentRequest).not.toHaveBeenCalled();
  });

  it('throws HttpError for a non-402 failure AFTER a 402 (retry path)', async () => {
    const { fetchMock } = mockFetch([
      jsonResponse(402, makeChallenge()),
      jsonResponse(503, 'Service Unavailable', { 'Content-Type': 'text/plain' }),
    ]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });

    const err = await client.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    // Best-effort body: JSON failed, raw text fallback.
    expect((err as HttpError).body).toBe('Service Unavailable');
  });

  it('throws PaymentRejectedError when the signed retry gets a SECOND 402', async () => {
    const fresh = makeChallenge({ token: 'nonce-2', payment: { ...makeChallenge().payment, nonce: 'nonce-2' } });
    const { fetchMock, calls } = mockFetch([
      jsonResponse(402, makeChallenge()),
      jsonResponse(402, fresh),
    ]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });

    const err = await client.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentRejectedError);
    expect((err as PaymentRejectedError).code).toBe('PAYMENT_REJECTED');
    expect((err as PaymentRejectedError).challenge).toEqual(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(calls[1], X_PAYMENT_HEADER)).toBeTruthy(); // retry was signed
  });

  it('throws RequestFailedError when fetch rejects (network failure)', async () => {
    const fetchMock = jest.fn(async () => {
      throw Object.assign(new Error('ECONNREFUSED'), { name: 'TypeError' });
    });
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });

    const err = await client.chat({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(RequestFailedError);
    expect((err as RequestFailedError).code).toBe('REQUEST_FAILED');
  });

  it('throws RequestFailedError for a 200 with a non-JSON body', async () => {
    const { fetchMock } = mockFetch([
      new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    ]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });
    await expect(client.chat({ messages: [] })).rejects.toBeInstanceOf(RequestFailedError);
  });

  it('merges paymentExtras into the X-PAYMENT submission (on-ledger txHash path)', async () => {
    const { fetchMock, calls } = mockFetch([
      jsonResponse(402, makeChallenge()),
      jsonResponse(200, { model: 'deepseek-v3', content: 'ok' }),
    ]);
    const client = new RouterClient({ routerUrl: BASE_URL, signer: fakeSigner(), fetch: fetchMock as unknown as typeof fetch });
    await client.chat({ messages: [] }, { paymentExtras: { txHash: 'a'.repeat(64) } });

    const sent = JSON.parse(headerOf(calls[1], X_PAYMENT_HEADER) as string);
    expect(sent.txHash).toBe('a'.repeat(64));
    expect(sent.nonce).toBe('nonce-1');
    expect(sent.payment).toEqual(makeChallenge().payment);
  });

  it('uses a custom path when configured', async () => {
    const { fetchMock, calls } = mockFetch([jsonResponse(200, { model: 'x', content: 'y' })]);
    const client = new RouterClient({
      routerUrl: BASE_URL,
      path: '/custom/chat',
      signer: fakeSigner(),
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.chat({ messages: [] });
    expect(calls[0].url).toBe(`${BASE_URL}/custom/chat`);
  });
});

describe('RouterClient — construction', () => {
  it('requires a routerUrl', () => {
    expect(() => new RouterClient({ signer: fakeSigner() } as never)).toThrow(/routerUrl/);
  });

  it('requires a signer (the SDK never holds key material)', () => {
    expect(() => new RouterClient({ routerUrl: BASE_URL } as never)).toThrow(/signer/);
  });
});

describe('XrplWalletSigner — xrpl.js Wallet adapter', () => {
  it('signs the canonical JSON of the payment request with the wrapped wallet', () => {
    const wallet = {
      address: 'rWALLETaddress00000000000000000000000',
      sign: jest.fn((msg: string) => ({ signature: `sig:${msg.length}`, hash: 'h' })),
    };
    const signer = new XrplWalletSigner(wallet);
    expect(signer.address).toBe(wallet.address);

    const req = makeChallenge().payment;
    const result = signer.signPaymentRequest(req);
    expect(wallet.sign).toHaveBeenCalledWith(JSON.stringify(req));
    expect(result).toBe(`sig:${JSON.stringify(req).length}`);
  });
});