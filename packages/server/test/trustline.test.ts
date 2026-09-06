/**
 * Tests for the optional T54 Trustline client and the risk gate it feeds.
 *
 * No network is touched. The request and response shapes asserted here are the
 * ones the live sandbox API returned on 2026-09-06 (see the header of
 * src/risk/trustline.ts): POST /validation/assess-async answers
 * `underwriting_async_submission.v1` with a `trustline_transaction_id`, and
 * GET /underwriting/transactions/{id} answers
 * `underwriting_transaction_status.v1` with a decision of APPROVE or DECLINE.
 * The 403 `api_key_scope_denied` body is the verbatim one the supplied sandbox
 * key produces today.
 */
import request from 'supertest';
import { createApp } from '../src/server';
import { loadConfig, ServerConfig } from '../src/config';
import { MockFacilitator } from '../src/facilitator/mock-facilitator';
import { Logger } from '../src/logger';
import {
  TrustlineAssessmentInput,
  TrustlineClient,
  TrustlineClientOptions,
  trustlineEnvironment,
} from '../src/risk/trustline';

const BASE_URL = 'https://portal.t54.ai/api/v1';
const SANDBOX_KEY = 'tl_sandbox_testkeyid.testsecret';
const TXN_ID = 'tl_txn_8a1b74f37205aaedb98ac0dd';

const INPUT: TrustlineAssessmentInput = {
  paymentId: 'mock-nonce-1-123',
  payer: 'rPayerAddr1234567890abcdefghijklmn',
  amount: '1000000',
  asset: 'XRP',
  receiver: 'rGATEWAYrecvTESTaddress98765432',
  network: 'xrpl:1',
  model: 'deepseek-chat',
  provider: 'deepseek',
  resourceUrl: 'https://gateway.example/v1/chat',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** POST /validation/assess-async, as the live sandbox answers it. */
function submission(overrides: Record<string, unknown> = {}): Response {
  return json({
    schema_version: 'underwriting_async_submission.v1',
    status: 'pending',
    trustline_transaction_id: TXN_ID,
    underwriting_request_id: INPUT.paymentId,
    job_id: 'uw_job_ef0c8c747e42',
    idempotency_key: `sonpay:${INPUT.paymentId}`,
    poll_url: `/api/v1/underwriting/transactions/${TXN_ID}`,
    retry_after_seconds: 3,
    ...overrides,
  });
}

/** GET /underwriting/transactions/{id}. */
function transaction(overrides: Record<string, unknown> = {}): Response {
  return json({
    schema_version: 'underwriting_transaction_status.v1',
    trustline_transaction_id: TXN_ID,
    status: 'completed',
    decision: 'APPROVE',
    risk_level: 'low',
    confidence: 0.93,
    reason_brief: 'Transaction approved.',
    reasons: [],
    warnings: [],
    retry_after_seconds: 0,
    ...overrides,
  });
}

/** A fetch stub that replays a queue of responses and records the calls. */
function stubFetch(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = jest.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected call to ${String(url)}`);
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function client(overrides: Partial<TrustlineClientOptions> = {}): TrustlineClient {
  return new TrustlineClient({
    baseUrl: BASE_URL,
    apiKey: SANDBOX_KEY,
    // No real waiting: the poll interval is exercised, not slept through.
    sleep: async () => undefined,
    ...overrides,
  });
}

function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

describe('Trustline configuration', () => {
  it('is off unless both the base URL and the key are set', async () => {
    const { fetchImpl } = stubFetch([]);
    for (const options of [
      { baseUrl: '', apiKey: SANDBOX_KEY },
      { baseUrl: BASE_URL, apiKey: '' },
      { baseUrl: '', apiKey: '' },
    ]) {
      const off = client({ ...options, fetchImpl });
      expect(off.enabled).toBe(false);
      await expect(off.assess(INPUT)).resolves.toEqual({ status: 'disabled' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads the environment off the key prefix, not off a separate variable', () => {
    expect(trustlineEnvironment('tl_sandbox_abc.def')).toBe('sandbox');
    expect(trustlineEnvironment('tl_production_abc.def')).toBe('production');
    expect(trustlineEnvironment('')).toBe('unknown');
    expect(client().environment).toBe('sandbox');
  });

  it('defaults to observe mode', () => {
    expect(client().mode).toBe('observe');
    expect(client({ mode: 'enforce' }).mode).toBe('enforce');
  });

  it('rejects an unrecognised T54_TRUSTLINE_MODE instead of silently observing', () => {
    const previous = process.env.T54_TRUSTLINE_MODE;
    process.env.T54_TRUSTLINE_MODE = 'enforced';
    try {
      expect(() => loadConfig()).toThrow(/Invalid T54_TRUSTLINE_MODE="enforced"/);
    } finally {
      if (previous === undefined) delete process.env.T54_TRUSTLINE_MODE;
      else process.env.T54_TRUSTLINE_MODE = previous;
    }
  });
});

describe('Trustline assessment', () => {
  it('submits the payment facts and polls the returned transaction to APPROVE', async () => {
    const { fetchImpl, calls } = stubFetch([submission(), transaction()]);
    const result = await client({ fetchImpl }).assess(INPUT);

    expect(result).toEqual({
      status: 'approved',
      transactionId: TXN_ID,
      riskLevel: 'low',
      confidence: 0.93,
      reasonBrief: 'Transaction approved.',
      reasons: [],
    });

    expect(calls).toHaveLength(2);
    const [submit, poll] = calls;
    expect(submit.url).toBe(`${BASE_URL}/validation/assess-async`);
    expect(submit.init.method).toBe('POST');
    expect(header(submit.init, 'Authorization')).toBe(`Bearer ${SANDBOX_KEY}`);

    const body = JSON.parse(String(submit.init.body));
    expect(body.assessment_type).toBe('transaction');
    expect(body.agent_id).toBe('sonpay-gateway');
    expect(body.transaction_data.transaction).toEqual({
      transaction_id: INPUT.paymentId,
      // 1_000_000 drops is 1 XRP: Trustline is sent the human amount.
      amount: 1,
      currency: 'XRP',
      chain: 'xrpl:1',
      recipient: INPUT.receiver,
    });
    expect(body.metadata).toEqual({ source: 'sonpay', environment: 'sandbox' });

    // The documented poll_url is root-relative; it must resolve against the
    // configured base, not be appended to it.
    expect(poll.url).toBe(`${BASE_URL}/underwriting/transactions/${TXN_ID}`);
    expect(poll.init.method).toBe('GET');
    // The docs say polling needs no auth; the live API answers 401 without it.
    expect(header(poll.init, 'Authorization')).toBe(`Bearer ${SANDBOX_KEY}`);
  });

  it('derives the Idempotency-Key from the payment so a replay cannot open a second assessment', async () => {
    const first = stubFetch([submission(), transaction()]);
    await client({ fetchImpl: first.fetchImpl }).assess(INPUT);
    const second = stubFetch([submission(), transaction()]);
    await client({ fetchImpl: second.fetchImpl }).assess(INPUT);

    const key = header(first.calls[0].init, 'Idempotency-Key');
    expect(key).toBe(`sonpay:${INPUT.paymentId}`);
    expect(header(second.calls[0].init, 'Idempotency-Key')).toBe(key);
  });

  it('never sends prompt or completion text', async () => {
    const { fetchImpl, calls } = stubFetch([submission(), transaction()]);
    await client({ fetchImpl }).assess({ ...INPUT });
    const sent = String(calls[0].init.body);
    expect(sent).not.toContain('messages');
    expect(JSON.parse(sent).transaction_data.request_body.body).toEqual({
      model: 'deepseek-chat',
      provider: 'deepseek',
      payment_id: INPUT.paymentId,
      payment_asset: 'XRP',
      network: 'xrpl:1',
      payer: INPUT.payer,
    });
  });

  it('keeps polling while the transaction is still in flight', async () => {
    const { fetchImpl, calls } = stubFetch([
      submission(),
      transaction({ status: 'running_validators', decision: undefined, retry_after_seconds: 3 }),
      transaction({ status: 'finalizing', decision: undefined, retry_after_seconds: 3 }),
      transaction(),
    ]);
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toMatchObject({
      status: 'approved',
    });
    expect(calls).toHaveLength(4);
  });

  it('reports a DECLINE with the reason Trustline gave', async () => {
    const { fetchImpl } = stubFetch([
      submission(),
      transaction({
        decision: 'DECLINE',
        risk_level: 'high',
        confidence: 0.81,
        reason_brief: 'Amount exceeds the configured agent limit.',
        reasons: ['AMOUNT_EXCEEDS_LIMIT'],
      }),
    ]);
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toEqual({
      status: 'declined',
      transactionId: TXN_ID,
      riskLevel: 'high',
      confidence: 0.81,
      reasonBrief: 'Amount exceeds the configured agent limit.',
      reasons: ['AMOUNT_EXCEEDS_LIMIT'],
    });
  });

  it('reads a decision that arrives inside final_result', async () => {
    const { fetchImpl } = stubFetch([
      submission(),
      json({
        trustline_transaction_id: TXN_ID,
        status: 'completed',
        final_result: { decision: 'DECLINE', risk_level: 'critical', reason_brief: 'No.' },
      }),
    ]);
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toMatchObject({
      status: 'declined',
      riskLevel: 'critical',
    });
  });
});

describe('Trustline failure handling — always fails open', () => {
  it('surfaces the live scope-denied error without blocking anything', async () => {
    const { fetchImpl } = stubFetch([
      json({ detail: { code: 'api_key_scope_denied', message: 'API key does not include required scopes' } }, 403),
    ]);
    const enforcing = client({ fetchImpl, mode: 'enforce' });
    const result = await enforcing.assess(INPUT);

    expect(result).toEqual({ status: 'unavailable', reason: 'api_key_scope_denied' });
    expect(enforcing.blocks(result)).toBe(false);
  });

  it('reports an invalid key by its code, and never echoes the key', async () => {
    const { fetchImpl } = stubFetch([
      json({ detail: { code: 'invalid_api_key', message: 'API key is invalid' } }, 401),
    ]);
    const result = await client({ fetchImpl }).assess(INPUT);
    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_api_key' });
    expect(JSON.stringify(result)).not.toContain(SANDBOX_KEY);
  });

  it('fails open when the transport fails', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toEqual({
      status: 'unavailable',
      reason: 'transport-error',
    });
  });

  it('gives up rather than hanging a paid request when no decision arrives', async () => {
    const { fetchImpl } = stubFetch([
      submission(),
      transaction({ status: 'running', decision: undefined }),
    ]);
    // A 1ms budget: the first poll is allowed, the second cannot fit.
    const result = await client({ fetchImpl, timeoutMs: 1 }).assess(INPUT);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'decision-timeout' });
  });

  it('does not answer an Agentic Challenge', async () => {
    const { fetchImpl } = stubFetch([
      submission(),
      transaction({ status: 'requires_information', decision: undefined }),
    ]);
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toEqual({
      status: 'unavailable',
      reason: 'challenge-required',
      transactionId: TXN_ID,
    });
  });

  it('treats a terminal failure and an unparseable submission as unavailable', async () => {
    const failed = stubFetch([submission(), transaction({ status: 'expired', decision: undefined })]);
    await expect(client({ fetchImpl: failed.fetchImpl }).assess(INPUT)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'status-expired',
    });

    const malformed = stubFetch([json({ status: 'pending' })]);
    await expect(client({ fetchImpl: malformed.fetchImpl }).assess(INPUT)).resolves.toEqual({
      status: 'unavailable',
      reason: 'malformed-submission',
    });
  });

  it('never approves a completed transaction that carries no decision', async () => {
    const { fetchImpl } = stubFetch([submission(), json({ status: 'completed' })]);
    await expect(client({ fetchImpl }).assess(INPUT)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'no-decision',
    });
  });
});

describe('what a decision does', () => {
  const declined = { status: 'declined' } as const;
  const approved = { status: 'approved' } as const;

  it('blocks only an explicit DECLINE, and only in enforce mode', () => {
    expect(client({ mode: 'observe' }).blocks(declined)).toBe(false);
    expect(client({ mode: 'enforce' }).blocks(declined)).toBe(true);
    expect(client({ mode: 'enforce' }).blocks(approved)).toBe(false);
    expect(client({ mode: 'enforce' }).blocks({ status: 'disabled' })).toBe(false);
    expect(client({ mode: 'enforce' }).blocks({ status: 'unavailable' })).toBe(false);
  });
});

describe('the risk gate on POST /v1/chat', () => {
  function app(overrides: Partial<ServerConfig>, fetchImpl?: typeof fetch) {
    const config = loadConfig({
      trustlineBaseUrl: BASE_URL,
      trustlineApiKey: SANDBOX_KEY,
      trustlineTimeoutMs: 2000,
      ...overrides,
    });
    return createApp({
      facilitator: new MockFacilitator(),
      config,
      logger: new Logger('error'),
      fetchImpl,
    });
  }

  /** Pay a 402 challenge with the mock facilitator and retry the request. */
  async function paid(server: ReturnType<typeof app>) {
    const challenge = await request(server).post('/v1/chat').send({ messages: [] });
    expect(challenge.status).toBe(402);
    const payment = challenge.body.payment;
    return request(server)
      .post('/v1/chat')
      .set(
        'X-PAYMENT',
        JSON.stringify({ nonce: payment.nonce, signature: 'mock-signature', payment })
      )
      .send({ messages: [{ role: 'user', content: 'hello' }] });
  }

  // The gate polls for real here (no injected sleep), so these fixtures ask
  // for the shortest interval the client allows instead of the live 3s.
  const quick = (overrides: Record<string, unknown> = {}) =>
    submission({ retry_after_seconds: 0, ...overrides });

  it('serves a request Trustline approves and reports the decision', async () => {
    const { fetchImpl } = stubFetch([quick(), transaction()]);
    const res = await paid(app({ trustlineMode: 'enforce' }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.risk).toMatchObject({ status: 'approved', riskLevel: 'low' });
  });

  it('refuses to run the model when Trustline declines and the gate enforces', async () => {
    const { fetchImpl } = stubFetch([
      quick(),
      transaction({ decision: 'DECLINE', risk_level: 'critical', reason_brief: 'Declined.' }),
    ]);
    const res = await paid(app({ trustlineMode: 'enforce' }, fetchImpl));

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: 'RISK_DECLINED',
      message: 'Declined.',
      risk: { status: 'declined', transactionId: TXN_ID },
    });
    // Nothing was generated: the decline landed before the model ran.
    expect(res.body.content).toBeUndefined();
    expect(res.body.usage).toBeUndefined();
  });

  it('still serves the request when the same decline only observes', async () => {
    const { fetchImpl } = stubFetch([
      quick(),
      transaction({ decision: 'DECLINE', risk_level: 'critical', reason_brief: 'Declined.' }),
    ]);
    const res = await paid(app({ trustlineMode: 'observe' }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.content).toEqual(expect.any(String));
    expect(res.body.risk).toMatchObject({ status: 'declined' });
  });

  it('serves the request when Trustline is unreachable, even while enforcing', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await paid(app({ trustlineMode: 'enforce' }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.risk).toEqual({ status: 'unavailable', reason: 'transport-error' });
  });

  it('changes nothing when Trustline is not configured', async () => {
    const { fetchImpl } = stubFetch([]);
    const res = await paid(app({ trustlineBaseUrl: '', trustlineApiKey: '' }, fetchImpl));

    expect(res.status).toBe(200);
    expect(res.body.risk).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never publishes the key through the config endpoint', async () => {
    const res = await request(app({})).get('/v1/config');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SANDBOX_KEY);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('trustline');
  });
});
