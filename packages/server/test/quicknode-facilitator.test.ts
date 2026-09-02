/**
 * Tests for the REAL XRPL payment verifier (QuickNodeFacilitator).
 *
 * All network calls are mocked with an injectable fetch — no real network
 * in unit tests. Every failure mode required by the security checklist is
 * covered: invalid / insufficient / wrong-destination / wrong-network /
 * malformed / duplicate / unbound / mismatched payments, plus RPC errors,
 * non-JSON responses and timeouts (all fail closed).
 *
 * The last describe() block proves the seam wiring: the real facilitator
 * works end-to-end through the x402 middleware (createApp), exactly like the
 * mock does, and createFacilitator() selects the real one from the
 * XRPL_RPC_URL env var.
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { createFacilitator, loadConfig } from '../src/index';
import {
  QuickNodeFacilitator,
  RLUSD_HEX_CODE,
} from '../src/facilitator/quicknode-facilitator';
import { PaymentRequest } from '../src/facilitator/facilitator';
import { X_PAYMENT_HEADER, X402Challenge } from '../src/x402';

// --- Fixtures ----------------------------------------------------------------

const RPC_URL = 'https://example.testnet.rpc';
const RECEIVER = 'rMOCKRECEIVERaddress00000000000000000';
const AMOUNT_DROPS = '1000000';
const TX_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

/** utf8 -> hex (what a payer puts in MemoData / InvoiceID). */
function hex(text: string): string {
  return Buffer.from(text, 'utf8').toString('hex');
}

/** A valid, fully-verified ledger `tx` response (customizable per test). */
function ledgerTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: TX_HASH,
    validated: true,
    TransactionType: 'Payment',
    Account: 'rPayerAddr1234567890abcdefghijklmn',
    Destination: RECEIVER,
    Amount: AMOUNT_DROPS,
    Memos: [{ Memo: { MemoType: hex('x402'), MemoData: hex('nonce-1') } }],
    NetworkID: 1,
    ledger_index: 123456,
    ...overrides,
  };
}

/** A fake rippled RPC responder: returns `{ result: <body> }` via JSON. */
function rpcResponder(body: unknown): typeof fetch {
  const response = {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
  return (async () => response) as unknown as typeof fetch;
}

function makeFacilitator(
  overrides: Partial<ConstructorParameters<typeof QuickNodeFacilitator>[0]> = {}
): QuickNodeFacilitator {
  return new QuickNodeFacilitator({
    network: 'xrpl:1',
    receiver: RECEIVER,
    rewardDrops: AMOUNT_DROPS,
    rpcUrl: RPC_URL,
    fetchImpl: rpcResponder({ result: ledgerTx({ Memos: [] }) }),
    ...overrides,
  });
}

/** Build the PaymentRequest the challenge would hand out. */
function challengeRequest(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    network: 'xrpl:1',
    receiver: RECEIVER,
    rewardDrops: AMOUNT_DROPS,
    nonce: 'nonce-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

/** Submit the X-PAYMENT body the real client sends: { txHash, payment }. */
function submittedPayment(txHash: string, req: PaymentRequest): Record<string, unknown> {
  return { txHash, payment: req };
}

// --- Real-verifier unit tests ------------------------------------------------

describe('QuickNodeFacilitator — real XRP payment verification', () => {
  it('accepts a valid XRP payment that passes every checklist item', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ Memos: [{ Memo: { MemoData: hex('nonce-1') } }] }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v).toEqual({ valid: true });
  });

  it('rejects an unvalidated (not-yet-confirmed) ledger entry', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: ledgerTx({ validated: false }) }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('invalid-payment');
  });

  it('rejects a transaction the ledger does not know', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: { status: 'error', error: 'txnNotFound' } }),
    });
    const v = await f.verifyPayment(
      submittedPayment(OTHER_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('invalid-payment');
  });

  it('rejects an insufficient payment (amount mismatch — exact match required)', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ Amount: '999999' }), // one drop short
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-amount');
  });

  it('rejects an over-payment too (exact match required)', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: ledgerTx({ Amount: '1000001' }) }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-amount');
  });

  it('rejects a payment to the wrong destination', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: ledgerTx({ Destination: 'rSOMEONEELSE' }) }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-destination');
  });

  it('rejects a non-Payment transaction type', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: ledgerTx({ TransactionType: 'OfferCreate' }) }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-transaction-type');
  });

  it('rejects a replayed (duplicate) payment hash', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ Memos: [{ Memo: { MemoData: hex('nonce-1') } }] }),
      }),
    });
    const req = challengeRequest();
    expect((await f.verifyPayment(submittedPayment(TX_HASH, req), req)).valid).toBe(true);
    // Same on-ledger payment submitted again must be rejected as a replay.
    const second = await f.verifyPayment(submittedPayment(TX_HASH, req), req);
    expect(second.valid).toBe(false);
    expect(second.reason).toBe('duplicate-payment');
  });

  it('fails closed on an RPC HTTP error', async () => {
    const response = { ok: false, status: 500 } as unknown as Response;
    const f = makeFacilitator({
      fetchImpl: (async () => response) as unknown as typeof fetch,
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:HTTP 500$/);
  });

  it('fails closed on a non-JSON RPC response', async () => {
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
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:non-JSON response$/);
  });

  it('fails closed on an RPC timeout (aborted fetch)', async () => {
    const f = makeFacilitator({
      fetchImpl: (async () => {
        throw new DOMException('aborted', 'AbortError');
      }) as unknown as typeof fetch,
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:timeout/);
  });

  it('fails closed on a network error', async () => {
    const f = makeFacilitator({
      fetchImpl: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof fetch,
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:network error/);
  });

  it('fails closed on an unexpected RPC error field', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: { status: 'error', error: 'unknownCmd' } }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/^facilitator-failure:RPC error: unknownCmd$/);
  });

  it('rejects a payment whose NetworkID does not match the challenge network', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ NetworkID: 0 }), // mainnet tx vs testnet challenge
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest({ network: 'xrpl:1' })),
      challengeRequest({ network: 'xrpl:1' })
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-network');
  });

  it('fails closed when the challenge names an unknown network id', async () => {
    const f = makeFacilitator();
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest({ network: 'xrpl:99' })),
      challengeRequest({ network: 'xrpl:99' })
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-network');
  });

  it('rejects a malformed X-PAYMENT with no txHash', async () => {
    const f = makeFacilitator();
    const v = await f.verifyPayment({ payment: challengeRequest() }, challengeRequest());
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('malformed-payment');
  });

  it('rejects a malformed txHash (not 64 hex chars)', async () => {
    const f = makeFacilitator();
    const v = await f.verifyPayment(
      submittedPayment('short-hash', challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('malformed-payment');
  });

  it('rejects a payment with no nonce binding (no memo, no InvoiceID)', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({ result: ledgerTx({ Memos: [] }) }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('unbound-payment');
  });

  it('rejects a payment whose memo binds a DIFFERENT nonce', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ Memos: [{ Memo: { MemoData: hex('nonce-999') } }] }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('nonce-mismatch');
  });

  it('rejects a payment submitted against an expired challenge', async () => {
    const f = makeFacilitator({
      now: () => Date.now() + 10 * 60 * 1000, // clock moved past the 5-min expiry
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest({ expiresAt: new Date(Date.now() + 60_000).toISOString() })
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('payment-request-expired');
  });

  it('accepts a nonce bound via InvoiceID instead of a memo', async () => {
    const f = makeFacilitator({
      fetchImpl: rpcResponder({
        result: ledgerTx({ Memos: [], InvoiceID: hex('nonce-1') }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, challengeRequest()),
      challengeRequest()
    );
    expect(v).toEqual({ valid: true });
  });
});

// --- RLUSD (same verification path, IOU amounts) -----------------------------

const RLUSD_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'; // testnet issuer

function rlusdChallenge(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    ...challengeRequest(),
    asset: 'RLUSD',
    issuer: RLUSD_ISSUER,
    rewardDrops: '1',
    ...overrides,
  };
}

describe('QuickNodeFacilitator — RLUSD (issued currency, same path)', () => {
  it('accepts a valid RLUSD payment (IOU amount object, exact value + issuer)', async () => {
    const f = makeFacilitator({
      asset: 'RLUSD',
      issuer: RLUSD_ISSUER,
      fetchImpl: rpcResponder({
        result: ledgerTx({
          Amount: { currency: RLUSD_HEX_CODE, value: '1', issuer: RLUSD_ISSUER },
        }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, rlusdChallenge()),
      rlusdChallenge()
    );
    expect(v).toEqual({ valid: true });
  });

  it('normalizes IOU values: ledger "1.0" matches challenge "1"', async () => {
    const f = makeFacilitator({
      asset: 'RLUSD',
      issuer: RLUSD_ISSUER,
      fetchImpl: rpcResponder({
        result: ledgerTx({
          Amount: { currency: RLUSD_HEX_CODE, value: '1.0', issuer: RLUSD_ISSUER },
        }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, rlusdChallenge()),
      rlusdChallenge()
    );
    expect(v).toEqual({ valid: true });
  });

  it('rejects RLUSD paid from the wrong issuer', async () => {
    const f = makeFacilitator({
      asset: 'RLUSD',
      issuer: RLUSD_ISSUER,
      fetchImpl: rpcResponder({
        result: ledgerTx({
          Amount: { currency: RLUSD_HEX_CODE, value: '1', issuer: 'rWRONGISSUER' },
        }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, rlusdChallenge()),
      rlusdChallenge()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-amount');
  });

  it('rejects RLUSD paid in a different currency code', async () => {
    const f = makeFacilitator({
      asset: 'RLUSD',
      issuer: RLUSD_ISSUER,
      fetchImpl: rpcResponder({
        result: ledgerTx({
          Amount: { currency: 'USD0000000000000000000000000000000000000000', value: '1', issuer: RLUSD_ISSUER },
        }),
      }),
    });
    const v = await f.verifyPayment(
      submittedPayment(TX_HASH, rlusdChallenge()),
      rlusdChallenge()
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('wrong-amount');
  });

  it('throws at construction when RLUSD is configured without an issuer', () => {
    expect(
      () =>
        new QuickNodeFacilitator({
          network: 'xrpl:1',
          receiver: RECEIVER,
          rewardDrops: '1',
          rpcUrl: RPC_URL,
          asset: 'RLUSD',
          issuer: '',
        })
    ).toThrow(/RLUSD_ISSUER is required/);
  });

  it('throws at construction on an unsupported asset symbol', () => {
    expect(
      () =>
        new QuickNodeFacilitator({
          network: 'xrpl:1',
          receiver: RECEIVER,
          rewardDrops: '1',
          rpcUrl: RPC_URL,
          asset: 'DOGE',
          issuer: 'rX',
        })
    ).toThrow(/Unsupported payment asset/);
  });
});

// --- Seam wiring: createFacilitator + x402 middleware end-to-end -------------

describe('Facilitator seam wiring (real facilitator)', () => {
  const REAL_CONFIG = loadConfig({
    paymentReceiver: RECEIVER,
    network: 'xrpl:1',
    rewardDrops: AMOUNT_DROPS,
    xrplRpcUrl: RPC_URL,
    logLevel: 'error',
  });

  it('createFacilitator selects the real verifier when XRPL_RPC_URL is set', () => {
    const f = createFacilitator(REAL_CONFIG);
    expect(f.name).toBe('quicknode-facilitator');
  });

  it('createFacilitator keeps the mock as the zero-config default', () => {
    const f = createFacilitator(loadConfig({ paymentReceiver: RECEIVER }));
    expect(f.name).toBe('mock-facilitator');
  });

  it('full flow: 402 -> real ledger payment -> verified -> routed 200 response', async () => {
    // Mutable fake ledger: the payer "binds" the memo to the challenge nonce
    // after receiving it, exactly like a real client would.
    const ledger = { nonce: '', amount: AMOUNT_DROPS };
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      void init; // the RPC body carries only the tx hash — the ledger answers
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: ledgerTx({
            Amount: ledger.amount,
            Memos: [{ Memo: { MemoData: hex(ledger.nonce) } }],
          }),
        }),
      };
    }) as unknown as typeof fetch;

    const app: Express = createApp({
      facilitator: new QuickNodeFacilitator({
        network: 'xrpl:1',
        receiver: RECEIVER,
        rewardDrops: AMOUNT_DROPS,
        rpcUrl: RPC_URL,
        fetchImpl,
      }),
      config: REAL_CONFIG,
    });

    // Step 1: unpaid request -> 402 challenge carrying the real payment request.
    const challengeRes = await request(app)
      .post('/v1/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] })
      .expect(402);
    const challenge = challengeRes.body as X402Challenge;

    // Step 2: payer submits a real tx whose memo binds the challenge nonce.
    ledger.nonce = challenge.payment.nonce;

    const paid = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify(submittedPayment(TX_HASH, challenge.payment)))
      .send({ messages: [{ role: 'user', content: 'hi' }] });

    expect(paid.status).toBe(200);
    expect(paid.body.model).toBe('deepseek-v3');
    expect(typeof paid.body.content).toBe('string');
  });

  it('a wrong-amount ledger payment through the middleware -> fresh 402, never 200', async () => {
    const app: Express = createApp({
      facilitator: new QuickNodeFacilitator({
        network: 'xrpl:1',
        receiver: RECEIVER,
        rewardDrops: AMOUNT_DROPS,
        rpcUrl: RPC_URL,
        fetchImpl: rpcResponder({
          result: ledgerTx({ Amount: '1', Memos: [{ Memo: { MemoData: hex('whatever') } }] }),
        }),
      }),
      config: REAL_CONFIG,
    });

    const challengeRes = await request(app)
      .post('/v1/chat')
      .send({ messages: [] })
      .expect(402);
    const challenge = challengeRes.body as X402Challenge;

    const res = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify(submittedPayment(TX_HASH, challenge.payment)))
      .send({ messages: [] });

    expect(res.status).toBe(402); // rejected -> fresh challenge, fail closed
    expect(res.body.scheme).toBe('x402');
  });  it('full RLUSD flow via env-driven config: PAYMENT_ASSET=RLUSD -> challenge -> verified -> 200', async () => {
    // Exactly the .env the operator would set for testnet RLUSD — everything
    // flows from config (PAYMENT_ASSET/RLUSD_ISSUER), not from code.
    const RLUSD_AMOUNT = '0.01';
    const config = loadConfig({
      paymentReceiver: RECEIVER,
      network: 'xrpl:1',
      rewardDrops: RLUSD_AMOUNT,
      xrplRpcUrl: RPC_URL,
      paymentAsset: 'RLUSD',
      rlusdIssuer: RLUSD_ISSUER,
      logLevel: 'error',
    });
    const facilitator = createFacilitator(config);
    expect(facilitator.name).toBe('quicknode-facilitator');
    const ledger = {
      nonce: '',
      amount: { currency: RLUSD_HEX_CODE, value: RLUSD_AMOUNT, issuer: RLUSD_ISSUER },
    };
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      void init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          result: ledgerTx({
            Amount: ledger.amount,
            Memos: [{ Memo: { MemoData: hex(ledger.nonce) } }],
          }),
        }),
      };
    }) as unknown as typeof fetch;
    const app = createApp({ facilitator, config, logger: undefined });
    const challengeRes = await request(app)
      .post('/v1/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] })
      .expect(402);
    const challenge = challengeRes.body as X402Challenge;
    expect(challenge.payment.asset).toBe('RLUSD');
    expect(challenge.payment.issuer).toBe(RLUSD_ISSUER);
    expect(challenge.payment.rewardDrops).toBe(RLUSD_AMOUNT);
    expect(challenge.payment.network).toBe('xrpl:1');
    ledger.nonce = challenge.payment.nonce;
    const paid = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, JSON.stringify(submittedPayment(TX_HASH, challenge.payment)))
      .send({ messages: [{ role: 'user', content: 'hi' }] });
    expect(paid.status).toBe(200);
    expect(paid.body.model).toBe('deepseek-v3');
    expect(typeof paid.body.content).toBe('string');
  });
});
