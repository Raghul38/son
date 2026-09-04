/**
 * Tests for the T54Facilitator (optional hosted-facilitator path).
 *
 * All T54 calls are mocked with an injectable fetch — no real network in unit
 * tests. The mocked responses match the DOCUMENTED hosted-facilitator wire
 * format (verified 2026-09-03 from https://xrpl-x402.t54.ai/docs/xrpl-scheme
 * and https://xrpl-facilitator-testnet.t54.ai/openapi.json):
 *
 *   POST /verify -> 200 { isValid, invalidReason?, payer?, extensions? }
 *   POST /settle -> 200 { success, transaction, network, payer?, errorReason? }
 *
 * Coverage:
 *   - selection matrix (createFacilitator for PAYMENT_FACILITATOR every value)
 *   - verify success through the documented response shape
 *   - every T54 failure mode fails closed (facilitator-failure)
 *   - missing-URL config error
 *   - full 402 -> X-PAYMENT -> verify+settle -> 200 flow through the middleware
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { createFacilitator, loadConfig } from '../src/index';
import { T54Facilitator, T54FacilitatorOptions } from '../src/facilitator/t54-facilitator';
import { PaymentRequest } from '../src/facilitator/facilitator';
import { X_PAYMENT_HEADER } from '../src/x402';

// --- Fixtures ----------------------------------------------------------------

const FAC_URL = 'https://xrpl-facilitator-testnet.t54.ai';
const RECEIVER = 'rMOCKRECEIVERaddress00000000000000000';
const AMOUNT_DROPS = '1000';
const INVOICE_ID = 'invoice-abc-123';
const TX_BLOB = '12000022800000002400000001'; // realistic hex-looking blob

/** Build the x402 v2 payment envelope the payer would submit. */
function submittedPayment(invoiceId: string): Record<string, unknown> {
  return {
    x402Version: 2,
    accepted: {
      scheme: 'exact',
      network: 'xrpl:1',
      amount: AMOUNT_DROPS,
      asset: 'XRP',
      payTo: RECEIVER,
      maxTimeoutSeconds: 600,
      extra: { sourceTag: 804681468, invoiceId },
    },
    payload: { signedTxBlob: TX_BLOB },
  };
}

/** A JSON-200 responder for the T54 hosted service. */
function jsonOk(body: unknown): typeof fetch {
  const response = {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
  return (async () => response) as unknown as typeof fetch;
}

function makeFacilitator(
  overrides: Partial<T54FacilitatorOptions> = {}
): T54Facilitator {
  return new T54Facilitator({
    baseUrl: FAC_URL,
    network: 'xrpl:1',
    receiver: RECEIVER,
    rewardDrops: AMOUNT_DROPS,
    fetchImpl: jsonOk({ isValid: true, payer: 'rPayer' }),
    ...overrides,
  });
}

/** The challenge we hand out, with the invoice id the client must bind to. */
async function issuedRequest(f: T54Facilitator): Promise<PaymentRequest> {
  return f.createPaymentRequest({
    network: 'xrpl:1',
    receiver: RECEIVER,
    rewardDrops: AMOUNT_DROPS,
  });
}

describe('T54Facilitator — hosted x402 verify+settle', () => {
  it('accepts a valid payment: /verify valid then /settle success', async () => {
    // Two distinct responses: /verify -> valid, /settle -> success.
    const f = makeFacilitator({
      fetchImpl: (async (_url: unknown, _init: unknown) => {
        const url = String(_url);
        if (url.endsWith('/verify')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ isValid: true, payer: 'rPayer' }),
          } as unknown as Response;
        }
        if (url.endsWith('/settle')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              transaction: 'A'.repeat(64),
              network: 'xrpl:1',
              payer: 'rPayer',
            }),
          } as unknown as Response;
        }
        throw new Error(`unexpected URL ${url}`);
      }),
    });

    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    // Attribution comes from the settlement response, not from the client.
    expect(v).toEqual({ valid: true, paymentId: 'A'.repeat(64), payer: 'rPayer' });
    // The same challenge cannot be accepted twice (in-memory replay guard).
    const second = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('payment-request-expired');
  });

  it('leaves the payer unknown when T54 attributes nobody', async () => {
    // Attribution is optional metadata: a facilitator that cannot name the
    // payer must not make us invent one, and must not affect the verdict.
    const fetchImpl = (async (_url: unknown) => {
      const url = String(_url);
      if (url.endsWith('/settle')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, network: 'xrpl:1' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ isValid: true }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const f = makeFacilitator({ fetchImpl });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);

    expect(v).toEqual({ valid: true });
    expect(v.payer).toBeUndefined();
  });

  it('rejects a payment the facilitator says is invalid (invalidReason surfaced)', async () => {
    const f = makeFacilitator({
      fetchImpl: jsonOk({ isValid: false, invalidReason: 'invalid_tx_blob', payer: null }),
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('invalid_tx_blob');
  });

  it('rejects when /settle returns success:false (errorReason surfaced)', async () => {
    const fetchImpl = (async (_url: unknown, _init: unknown) => {
      const url = String(_url);
      if (url.endsWith('/verify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isValid: true, payer: 'rPayer' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: false,
          transaction: '',
          network: 'xrpl:1',
          payer: null,
          errorReason: 'verify_failed:amount_mismatch',
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const f = makeFacilitator({ fetchImpl });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('verify_failed:amount_mismatch');
  });

  it('rejects a malformed X-PAYMENT (missing x402Version / signedTxBlob)', async () => {
    const f = makeFacilitator();
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(
      { accepted: {}, payload: {} }, // not an x402 v2 envelope
      req
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('malformed-payment');
  });

  it('rejects a payment against an unknown or expired challenge', async () => {
    const f = makeFacilitator({ now: () => Date.now() + 10 * 60 * 1000 });
    const req = await issuedRequest(f);
    // Unknown nonce -> expired (no stored invoice).
    const v = await f.verifyPayment(
      submittedPayment('unknown'),
      { ...req, nonce: 'never-issued' }
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('payment-request-expired');
  });

  it('builds T54 requirements from OUR terms, not the client\'s accepted copy', async () => {
    // The client echoes its OWN accepted (different amount/payTo). Our
    // facilitator must send the server's terms in paymentRequirements.
    let sentRequirements: unknown = null;
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (String(_url).endsWith('/verify')) sentRequirements = body.paymentRequirements;
      if (String(_url).endsWith('/settle')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            transaction: 'A'.repeat(64),
            network: 'xrpl:1',
            payer: 'rPayer',
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ isValid: true, payer: 'rPayer' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const f = makeFacilitator({ fetchImpl });
    const req = await issuedRequest(f);
    const attackerEnvelope = {
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: 'xrpl:1',
        amount: '1', // attacker-claimed amount
        asset: 'XRP',
        payTo: 'rAttackerAddress0000000000000000000',
        maxTimeoutSeconds: 600,
        extra: { sourceTag: 804681468, invoiceId: 'whatever' },
      },
      payload: { signedTxBlob: TX_BLOB },
    };
    const v = await f.verifyPayment(attackerEnvelope, req);
    expect(v).toEqual({ valid: true, paymentId: 'A'.repeat(64), payer: 'rPayer' });
    const sent = sentRequirements as Record<string, unknown>;
    expect(sent.amount).toBe(AMOUNT_DROPS); // OUR amount, not "1"
    expect(sent.payTo).toBe(RECEIVER); // OUR receiver, not the attacker's
    expect(sent.scheme).toBe('exact');
    expect(sent.network).toBe('xrpl:1');
    expect((sent.extra as Record<string, unknown>).invoiceId).toBe(req.nonce);
  });

  // --- Fail-closed modes ------------------------------------------------------

  it('fails closed on an HTTP error from T54', async () => {
    const response = { ok: false, status: 503 } as unknown as Response;
    const f = makeFacilitator({
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:HTTP 503$/);
  });

  it('fails closed on a non-JSON response from T54', async () => {
    const response = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;
    const f = makeFacilitator({
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:non-JSON response$/);
  });

  it('fails closed on a T54 timeout (aborted fetch)', async () => {
    const f = makeFacilitator({
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as unknown as typeof fetch,
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:timeout/);
  });

  it('fails closed on a network error from T54', async () => {
    const f = makeFacilitator({
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:network error/);
  });

  it('fails closed when /settle itself errors after /verify passed', async () => {
    // /verify ok, then /settle throws (network) — must NOT grant access.
    const fetchImpl = (async (_url: unknown, _init: unknown) => {
      if (String(_url).endsWith('/verify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ isValid: true, payer: 'rPayer' }),
        } as unknown as Response;
      }
      throw new Error('settle timeout');
    }) as unknown as typeof fetch;
    const f = makeFacilitator({ fetchImpl });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure/);
  });

  it('fails closed on a malformed (scalar) T54 response body', async () => {
    const response = { ok: true, status: 200, json: async () => 'not-object' } as unknown as Response;
    const f = makeFacilitator({
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
    const req = await issuedRequest(f);
    const v = await f.verifyPayment(submittedPayment(INVOICE_ID), req);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:malformed response body/);
  });

  it('throws at construction when no base URL is given', () => {
    expect(
      () =>
        new T54Facilitator({
          baseUrl: '',
          network: 'xrpl:1',
          receiver: RECEIVER,
          rewardDrops: AMOUNT_DROPS,
        })
    ).toThrow(/T54_FACILITATOR_URL/);
  });

  it('throws at construction on an unsupported asset', () => {
    expect(
      () =>
        new T54Facilitator({
          baseUrl: FAC_URL,
          network: 'xrpl:1',
          receiver: RECEIVER,
          rewardDrops: '1',
          asset: 'DOGE',
        })
    ).toThrow(/only "XRP" or "RLUSD"/);
  });

  it('throws at construction on RLUSD without an issuer', () => {
    expect(
      () =>
        new T54Facilitator({
          baseUrl: FAC_URL,
          network: 'xrpl:1',
          receiver: RECEIVER,
          rewardDrops: '1',
          asset: 'RLUSD',
          issuer: '',
        })
    ).toThrow(/issuer/);
  });
});

// --- Seam wiring: createFacilitator selection matrix -------------------------

describe('Facilitator selection matrix (PAYMENT_FACILITATOR)', () => {
  const base = {
    paymentReceiver: RECEIVER,
    network: 'xrpl:1',
    rewardDrops: AMOUNT_DROPS,
    logLevel: 'error' as const,
  };

  it('default (unset) keeps the zero-config mock facilitator', () => {
    const f = createFacilitator(loadConfig({ ...base }));
    expect(f.name).toBe('mock-facilitator');
  });

  it('PAYMENT_FACILITATOR=mock keeps the current zero-config behavior (legacy: XRPL_RPC_URL unset -> mock)', () => {
    const f = createFacilitator(
      loadConfig({ ...base, paymentFacilitator: 'mock' })
    );
    expect(f.name).toBe('mock-facilitator');
    // Backward compat: with the DEFAULT selector, XRPL_RPC_URL set still
    // auto-selects the real verifier (see "legacy behavior" test below).
  });

  it('PAYMENT_FACILITATOR=quicknode + XRPL_RPC_URL -> quicknode-facilitator', () => {
    const f = createFacilitator(
      loadConfig({ ...base, paymentFacilitator: 'quicknode', xrplRpcUrl: 'https://rpc' })
    );
    expect(f.name).toBe('quicknode-facilitator');
  });

  it('PAYMENT_FACILITATOR=quicknode without XRPL_RPC_URL -> clear config error', () => {
    expect(() =>
      createFacilitator(loadConfig({ ...base, paymentFacilitator: 'quicknode' }))
    ).toThrow(/PAYMENT_FACILITATOR=quicknode requires XRPL_RPC_URL/);
  });

  it('PAYMENT_FACILITATOR=t54 + T54_FACILITATOR_URL -> t54-facilitator', () => {
    const f = createFacilitator(
      loadConfig({ ...base, paymentFacilitator: 't54', t54FacilitatorUrl: FAC_URL })
    );
    expect(f.name).toBe('t54-facilitator');
  });

  it('PAYMENT_FACILITATOR=t54 without T54_FACILITATOR_URL -> clear config error', () => {
    expect(() =>
      createFacilitator(loadConfig({ ...base, paymentFacilitator: 't54' }))
    ).toThrow(/PAYMENT_FACILITATOR=t54 requires T54_FACILITATOR_URL/);
  });

  it('legacy behavior: XRPL_RPC_URL set with default selector -> quicknode (backward compatible)', () => {
    const f = createFacilitator(loadConfig({ ...base, xrplRpcUrl: 'https://rpc' }));
    expect(f.name).toBe('quicknode-facilitator');
  });
});

// --- Full flow through the x402 middleware -----------------------------------

describe('T54 facilitator seam wiring (hosted path)', () => {
  const T54_CONFIG = loadConfig({
    paymentReceiver: RECEIVER,
    network: 'xrpl:1',
    rewardDrops: AMOUNT_DROPS,
    paymentFacilitator: 't54',
    t54FacilitatorUrl: FAC_URL,
    logLevel: 'error',
  });

  it('402 -> verified payment (verify+settle) -> routed 200 response', async () => {
    // Two-URL fake: /verify valid, /settle success. Records the server terms.
    const sentRequirements: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as RequestInit).body));
      if (String(_url).endsWith('/verify')) {
        sentRequirements.push(body.paymentRequirements);
        return {
          ok: true,
          status: 200,
          json: async () => ({ isValid: true, payer: 'rPayer' }),
        } as unknown as Response;
      }
      if (String(_url).endsWith('/settle')) {
        sentRequirements.push(body.paymentRequirements);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            transaction: 'A'.repeat(64),
            network: 'xrpl:1',
            payer: 'rPayer',
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected URL ${String(_url)}`);
    }) as unknown as typeof fetch;

    const facilitator = new T54Facilitator({
      baseUrl: T54_CONFIG.t54FacilitatorUrl,
      network: T54_CONFIG.network,
      receiver: T54_CONFIG.paymentReceiver,
      rewardDrops: T54_CONFIG.rewardDrops,
      asset: T54_CONFIG.paymentAsset,
      issuer: T54_CONFIG.paymentAsset === 'XRP' ? undefined : T54_CONFIG.rlusdIssuer,
      fetchImpl,
    });
    const app: Express = createApp({ facilitator, config: T54_CONFIG, logger: undefined });

    // Step 1: unpaid request -> 402 challenge.
    const challengeRes = await request(app)
      .post('/v1/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] })
      .expect(402);
    const challenge = challengeRes.body as { payment: PaymentRequest };

    // Step 2: payer submits an x402 v2 envelope binding to the challenge nonce.
    const envelope = submittedPayment(challenge.payment.nonce);
    const paid = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify(envelope))
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(paid.status).toBe(200);
    expect(paid.body.model).toBe('deepseek-v3');
    // Both /verify and /settle were called with OUR terms.
    expect(sentRequirements.length).toBe(2);
    expect(sentRequirements[0].amount).toBe(AMOUNT_DROPS);
    expect(sentRequirements[1].payTo).toBe(RECEIVER);
  });

  it('a rejected T54 payment through the middleware -> fresh 402, never 200', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isValid: false, invalidReason: 'amount_mismatch', payer: null }),
    })) as unknown as typeof fetch;
    const facilitator = new T54Facilitator({
      baseUrl: T54_CONFIG.t54FacilitatorUrl,
      network: T54_CONFIG.network,
      receiver: T54_CONFIG.paymentReceiver,
      rewardDrops: T54_CONFIG.rewardDrops,
      fetchImpl,
    });
    const app: Express = createApp({ facilitator, config: T54_CONFIG, logger: undefined });

    const challengeRes = await request(app)
      .post('/v1/chat')
      .send({ messages: [] })
      .expect(402);
    const challenge = challengeRes.body as { payment: PaymentRequest };
    const envelope = submittedPayment(challenge.payment.nonce);

    const res = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify(envelope))
      .send({ messages: [] });
    expect(res.status).toBe(402); // rejected -> fresh challenge, fail closed
    expect(res.body.scheme).toBe('x402');
  });
});