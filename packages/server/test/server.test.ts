/**
 * Server tests: the full x402 payment-gating flow against the MockFacilitator.
 *
 * Covers:
 *   - unpaid request -> 402 challenge per the x402 wire spec
 *   - paid request   -> 200 with a routed model (cheapest capable match)
 *   - rejected payment -> fresh 402
 *   - routing errors  -> 400
 *   - unknown route   -> 404
 */
import { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server';
import { loadConfig } from '../src/config';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import {
  X_PAYMENT_HEADER,
  X402_SCHEME,
  CHALLENGE_CONTENT_TYPE,
  X402Challenge,
} from '../src/x402';

const TEST_CONFIG = loadConfig({
  paymentReceiver: 'rMOCKRECEIVERaddress00000000000000000',
  network: 'xrpl:1', // testnet — never hardcode mainnet
  rewardDrops: '1000000',
  logLevel: 'error',
});

function buildApp(): Express {
  return createApp({ facilitator: new MockFacilitator(), config: TEST_CONFIG });
}

function challengePayload(body: request.Response): X402Challenge {
  return body.body as X402Challenge;
}

/** Helper: perform the two-step handshake and return the paid response. */
async function paidChat(
  app: Express,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Promise<request.Response> {
  const challengeRes = await request(app).post('/v1/chat').send(payload).expect(402);
  const challenge = challengePayload(challengeRes);
  const payment = {
    nonce: challenge.token,
    signature: 'test-signature',
    payment: challenge.payment,
    ...overrides,
  };
  return request(app)
    .post('/v1/chat')
    .set(X_PAYMENT_HEADER, JSON.stringify(payment))
    .send(payload);
}

describe('POST /v1/chat — x402 payment gating', () => {
  it('returns 402 with an x402 challenge when no payment is provided', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/chat')
      .send({ messages: [{ role: 'user', content: 'hi' }] })
      .expect(402);

    expect(res.headers['www-authenticate']).toBe(X402_SCHEME);
    expect(res.headers['content-type']).toContain('application/vnd+http.x402.challenge+json');

    const challenge = res.body as X402Challenge;
    expect(challenge.scheme).toBe('x402');
    expect(challenge.token).toBeTruthy();
    expect(challenge.payment.network).toBe('xrpl:1');
    expect(challenge.payment.receiver).toBe(TEST_CONFIG.paymentReceiver);
    expect(challenge.payment.rewardDrops).toBe('1000000');
    expect(challenge.payment.nonce).toBe(challenge.token);
    expect(new Date(challenge.payment.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts a valid payment and returns a routed 200 response', async () => {
    const app = buildApp();
    const res = await paidChat(app, {
      messages: [{ role: 'user', content: 'hello' }],
      capabilities: ['vision'],
    });

    expect(res.status).toBe(200);
    expect(res.body.model).toBe('gpt-4o-mini'); // cheapest model with vision
    expect(res.body.costPer1MTokens).toBe(0.6);
    expect(typeof res.body.content).toBe('string');
    expect(res.body.content).toContain('gpt-4o-mini');
  });

  it('routes to the cheapest model for a plain chat request without capabilities', async () => {
    const app = buildApp();
    const res = await paidChat(app, {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('deepseek-v3'); // cheapest overall
  });

  it('respects the cost ceiling in routing', async () => {
    const app = buildApp();
    const res = await paidChat(app, {
      messages: [],
      capabilities: ['chat'],
      maxCostPer1MTokens: 0.6,
    });
    expect(res.status).toBe(200);
    expect(res.body.model).toBe('deepseek-v3'); // 0.25 <= 0.6, cheapest
  });

  it('rejects a payment with a mismatched nonce with a fresh 402', async () => {
    const app = buildApp();
    const res = await paidChat(
      app,
      { messages: [] },
      { nonce: 'wrong-nonce-value' }
    );
    expect(res.status).toBe(402);
    expect(res.headers['www-authenticate']).toBe(X402_SCHEME);
    expect(res.body.payment).toBeTruthy();
    expect(res.body.scheme).toBe('x402');
  });

  it('rejects a payment with a missing signature with 402', async () => {
    const app = buildApp();
    const res = await paidChat(app, { messages: [] }, { signature: '' });
    expect(res.status).toBe(402);
  });

  it('rejects a payment request whose terms are not the ones this server asked for', async () => {
    // The payer echoes the challenge's payment request back to us, so its
    // terms are client-supplied: a self-authored receiver/amount must not be
    // accepted, or a payer could pay itself 1 drop and still be served.
    const app = buildApp();
    const challengeRes = await request(app).post('/v1/chat').send({ messages: [] }).expect(402);
    const challenge = challengePayload(challengeRes);

    const forged = [
      { ...challenge.payment, receiver: 'rPAYERSOWNwallet00000000000000000000' },
      { ...challenge.payment, rewardDrops: '1' },
      { ...challenge.payment, network: 'xrpl:0' },
      { ...challenge.payment, asset: 'RLUSD', issuer: 'rSOMEISSUER0000000000000000000000000' },
    ];
    for (const payment of forged) {
      const res = await request(app)
        .post('/v1/chat')
        .set(
          X_PAYMENT_HEADER,
          JSON.stringify({ nonce: challenge.token, signature: 'test-signature', payment })
        )
        .send({ messages: [] });
      expect(res.status).toBe(402);
      expect(res.body.scheme).toBe('x402');
    }
  });

  it('rejects an unparseable X-PAYMENT header with 402', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/v1/chat')
      .set(X_PAYMENT_HEADER, 'not-json{{{')
      .send({ messages: [] })
      .expect(402);
    expect(res.body.scheme).toBe('x402');
  });

  it('returns 400 UNKNOWN_CAPABILITY for an unknown capability', async () => {
    const app = buildApp();
    const res = await paidChat(app, {
      messages: [],
      capabilities: ['telepathy' as never],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNKNOWN_CAPABILITY');
  });

  it('returns 400 NO_ROUTE when no model satisfies the request', async () => {
    const app = buildApp();
    const res = await paidChat(app, {
      messages: [],
      capabilities: ['vision'],
      maxCostPer1MTokens: 0.5,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_ROUTE');
    expect(res.body.reason).toBe('no-model-under-cost-ceiling');
  });

  it('returns 404 for unknown routes', async () => {
    const app = buildApp();
    const res = await request(app).post('/v1/chat/extra').send({}).expect(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('never exposes a secret in the 402 challenge (no signing server-side)', async () => {
    // The challenge must contain only the public payment request — no private
    // key material, no signatures, no wallet secrets.
    const app = buildApp();
    const res = await request(app).post('/v1/chat').send({ messages: [] }).expect(402);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/private/i);
    expect(raw).not.toMatch(/seed|secret|mnemonic|signature/i);
    expect(raw).toContain(TEST_CONFIG.paymentReceiver);
  });
});