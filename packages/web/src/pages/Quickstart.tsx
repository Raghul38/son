/**
 * API quickstart — the endpoint, the example request, the 402 flow and the
 * response, plus a playground that runs the whole handshake for real.
 *
 * The playground is not a simulation. Step 1 posts to `/v1/chat` and shows the
 * challenge the gateway actually returned; step 3 posts again with an
 * `X-PAYMENT` header and shows whatever comes back, including a rejection.
 * The wallet step is deliberately manual: the gateway never holds a key and
 * never signs for a payer, so paying is something you do in your own wallet.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, chat, type ChatResponse, type PaymentTerms, type X402Challenge } from '../api';
import { amount, hexMemo, tokens, usd, useApi } from '../hooks';
import { Badge, Card, Code, ErrorNote, Mono, PageHead, Table } from '../components/ui';

const DEFAULT_PROMPT = 'In one sentence: what is the XRP Ledger?';

type Stage = 'idle' | 'challenged' | 'paid' | 'failed';

function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return iso;
  if (ms <= 0) return 'expired';
  return `${Math.floor(ms / 1000)}s`;
}

export function Quickstart() {
  const config = useApi((signal) => api.config(signal));
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [stage, setStage] = useState<Stage>('idle');
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<X402Challenge | undefined>();
  const [txHash, setTxHash] = useState('');
  const [answer, setAnswer] = useState<ChatResponse | undefined>();
  const [status, setStatus] = useState<number | undefined>();
  const [failure, setFailure] = useState<string | undefined>();

  const isMock = config.data?.payment.facilitator === 'mock-facilitator';
  const body = { messages: [{ role: 'user', content: prompt }] };
  const origin = window.location.origin;

  const reset = () => {
    setStage('idle');
    setChallenge(undefined);
    setAnswer(undefined);
    setStatus(undefined);
    setFailure(undefined);
    setTxHash('');
  };

  /** Step 1: the unpaid request, which is supposed to fail with a 402. */
  const askForChallenge = async () => {
    setBusy(true);
    setFailure(undefined);
    setAnswer(undefined);
    try {
      const attempt = await chat(body);
      setStatus(attempt.status);
      if (attempt.status === 402 && attempt.challenge !== undefined) {
        setChallenge(attempt.challenge);
        setStage('challenged');
      } else {
        // A gateway that answers an unpaid request is misconfigured, not a
        // success — say so rather than quietly showing the answer.
        setAnswer(attempt.body);
        setFailure(
          `Expected HTTP 402 but the gateway answered ${attempt.status}. This endpoint should be payment-gated.`
        );
        setStage('failed');
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setStage('failed');
    } finally {
      setBusy(false);
    }
  };

  /** Step 3: retry with proof of payment. */
  const submitPayment = async (header: string) => {
    setBusy(true);
    setFailure(undefined);
    try {
      const attempt = await chat(body, header);
      setStatus(attempt.status);
      if (attempt.status === 200 && attempt.body !== undefined) {
        setAnswer(attempt.body);
        setStage('paid');
      } else if (attempt.status === 402) {
        setFailure(
          'The facilitator did not accept that payment. The challenge below is a fresh one — ' +
            'check the destination, the exact amount, and that the memo is the hex-encoded nonce.'
        );
        if (attempt.challenge !== undefined) setChallenge(attempt.challenge);
        setStage('challenged');
      } else {
        setAnswer(attempt.body);
        setFailure(attempt.body?.message ?? attempt.body?.error ?? `HTTP ${attempt.status}`);
        setStage('failed');
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setStage('failed');
    } finally {
      setBusy(false);
    }
  };

  const payWithHash = () => {
    if (challenge === undefined || txHash.trim() === '') return;
    void submitPayment(
      JSON.stringify({ txHash: txHash.trim(), payment: challenge.payment })
    );
  };

  const payWithMock = () => {
    if (challenge === undefined) return;
    void submitPayment(
      JSON.stringify({
        nonce: challenge.token,
        signature: 'console-quickstart',
        payment: challenge.payment,
      })
    );
  };

  const terms: PaymentTerms | undefined = challenge?.payment;
  const content = answer?.content;

  return (
    <div className="page">
      <PageHead
        title="API quickstart"
        lead="One endpoint, one payment, one answer. Everything below runs against this gateway."
      />

      {config.error !== undefined && <ErrorNote message={config.error} onRetry={config.reload} />}

      <Card title="The endpoint">
        <Table head={['', '']}>
          <tr>
            <td>URL</td>
            <td>
              <Mono>
                POST {origin}
                {config.data?.endpoints.chat ?? '/v1/chat'}
              </Mono>
            </td>
          </tr>
          <tr>
            <td>Auth</td>
            <td>
              An <Mono>X-PAYMENT</Mono> header carrying proof of an XRP Ledger payment. No API key
              exists and none is needed.
            </td>
          </tr>
          <tr>
            <td>Price</td>
            <td>
              {config.data !== undefined
                ? `${amount(config.data.payment.amount, config.data.payment.asset)} per request`
                : '—'}
            </td>
          </tr>
          <tr>
            <td>Receiver</td>
            <td>
              <Mono>{config.data?.payment.receiver !== '' ? config.data?.payment.receiver : 'not configured'}</Mono>
            </td>
          </tr>
          <tr>
            <td>Network</td>
            <td>
              <Mono>{config.data?.payment.network}</Mono>{' '}
              <span className="muted small">
                verified by {config.data?.payment.facilitator}
                {isMock && ' — a local mock, not the ledger'}
              </span>
            </td>
          </tr>
        </Table>
      </Card>

      <Card title="1 · Example request">
        <Code
          label="curl"
          code={`curl -isS -X POST ${origin}/v1/chat \\
  -H 'Content-Type: application/json' \\
  -d '{
    "messages": [{"role": "user", "content": "${DEFAULT_PROMPT}"}],
    "capabilities": ["chat"],
    "maxCostPer1MTokens": 1.0
  }'`}
        />
        <p className="muted small">
          <Mono>capabilities</Mono> and <Mono>maxCostPer1MTokens</Mono> are optional: they
          constrain which models the router may pick. Omit them and it takes the cheapest model
          that can chat.
        </p>
      </Card>

      <Card title="2 · The 402 challenge">
        <p className="muted">
          An unpaid request is answered with <Mono>402 Payment Required</Mono>,{' '}
          <Mono>WWW-Authenticate: x402</Mono> and a challenge body. The{' '}
          <Mono>nonce</Mono> binds a payment to this one request — reusing a transaction for a
          second request is refused.
        </p>
        <Code
          label="HTTP 402"
          code={`HTTP/1.1 402 Payment Required
WWW-Authenticate: x402
Content-Type: application/vnd+http.x402.challenge+json

{
  "scheme": "x402",
  "token": "<nonce>",
  "payment": {
    "network": "${config.data?.payment.network ?? 'xrpl:1'}",
    "receiver": "${config.data?.payment.receiver !== undefined && config.data.payment.receiver !== '' ? config.data.payment.receiver : '<receiver address>'}",
    "rewardDrops": "${config.data?.payment.amount ?? '1000000'}",
    "nonce": "<nonce>",
    "expiresAt": "<ISO-8601, 5 minutes out>"
  }
}`}
        />
      </Card>

      <Card title="3 · Pay, then retry">
        <p className="muted">
          Send the exact amount to the receiver from your own wallet, with the nonce hex-encoded
          into a memo, and retry the identical request with the transaction hash attached.
        </p>
        <Code
          label="curl"
          code={`curl -sS -X POST ${origin}/v1/chat \\
  -H 'Content-Type: application/json' \\
  -H 'X-PAYMENT: {"txHash":"<TX_HASH>","payment":<the payment object from the challenge>}' \\
  -d '{"messages":[{"role":"user","content":"${DEFAULT_PROMPT}"}]}'`}
        />
      </Card>

      <Card title="4 · The answer">
        <Code
          label="HTTP 200"
          code={`{
  "model": "<model the router chose>",
  "modelProvider": "<provider>",
  "content": "…the answer…",
  "costPer1MTokens": 0.71,
  "usage": {"prompt_tokens": 24, "completion_tokens": 31, "total_tokens": 55},
  "pricing": {
    "currency": "USD",
    "providerCostUsd": 0.0000...,
    "markupBps": ${config.data?.pricing.markupBps ?? 500},
    "customerPriceUsd": 0.0000...,
    "platformFeeUsd": 0.0000...
  },
  "routing": {"strategy": "${config.data?.routing.strategy ?? 'cheapest'}", "chain": ["…"], "attempts": 1},
  "metering": {"status": "sent", "customer": {"status": "…"}}
}`}
        />
        <p className="muted small">
          A response with <Mono>"stub": true</Mono> means the routed provider is not configured on
          this server: no tokens were used and nothing was billed for AI work. The x402 payment is
          still spent — it bought the route.
        </p>
      </Card>

      <hr className="rule" />

      <Card
        title="Try it against this gateway"
        subtitle="A real request, a real challenge, a real verification. Nothing here is stubbed by the console."
        actions={
          stage !== 'idle' ? (
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Start over
            </button>
          ) : undefined
        }
      >
        <label className="field">
          <span>Your prompt</span>
          <textarea
            value={prompt}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={stage !== 'idle'}
          />
        </label>

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void askForChallenge()}
            disabled={busy || stage !== 'idle' || prompt.trim() === ''}
          >
            {busy && stage === 'idle' ? 'Sending…' : 'Send request'}
          </button>
          {status !== undefined && (
            <span className="muted small">
              gateway answered <Mono>HTTP {status}</Mono>
            </span>
          )}
        </div>

        {failure !== undefined && (
          <div className="note note-bad">
            <p>{failure}</p>
          </div>
        )}

        {terms !== undefined && stage === 'challenged' && (
          <div className="play-step">
            <h3>
              <Badge tone="accent">402</Badge> Pay to continue
            </h3>
            <Table head={['Field', 'Value']}>
              <tr>
                <td>Destination</td>
                <td>
                  <Mono>{terms.receiver}</Mono>
                </td>
              </tr>
              <tr>
                <td>Amount</td>
                <td>
                  <Mono>{terms.rewardDrops}</Mono>{' '}
                  <span className="muted">
                    ({amount(terms.rewardDrops, terms.asset ?? 'XRP')}, exact)
                  </span>
                </td>
              </tr>
              <tr>
                <td>Asset</td>
                <td>
                  {terms.asset ?? 'XRP'}
                  {terms.issuer !== undefined && (
                    <>
                      {' '}
                      <span className="muted small">issuer {terms.issuer}</span>
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td>Network</td>
                <td>
                  <Mono>{terms.network}</Mono>
                </td>
              </tr>
              <tr>
                <td>Memo (hex)</td>
                <td>
                  <Mono>{hexMemo(terms.nonce)}</Mono>
                  <div className="muted small">
                    the nonce <Mono>{terms.nonce}</Mono>, hex-encoded
                  </div>
                </td>
              </tr>
              <tr>
                <td>Expires</td>
                <td>
                  {expiresIn(terms.expiresAt)} <span className="muted small">from now</span>
                </td>
              </tr>
            </Table>

            <p className="muted small">
              Pay from any XRPL wallet — Xaman, Crossmark, GemWallet, or the{' '}
              <Mono>xrpl</Mono> library. Sonpay never asks for a seed, a private key or a wallet
              connection: it only ever sees a transaction hash that is already on the ledger.
            </p>

            <label className="field">
              <span>Transaction hash</span>
              <input
                value={txHash}
                placeholder="64 hex characters"
                onChange={(e) => setTxHash(e.target.value)}
              />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={payWithHash}
                disabled={busy || txHash.trim() === ''}
              >
                {busy ? 'Verifying…' : 'Submit payment'}
              </button>
              {isMock && (
                <button type="button" className="btn btn-ghost" onClick={payWithMock} disabled={busy}>
                  Simulate payment (mock facilitator)
                </button>
              )}
            </div>
            {isMock && (
              <p className="muted small">
                This gateway is running the <strong>mock facilitator</strong>, which accepts a
                signed nonce instead of an on-ledger transaction. That button proves the flow, not
                a payment. Point <Mono>PAYMENT_FACILITATOR</Mono> at <Mono>quicknode</Mono> or{' '}
                <Mono>t54</Mono> for real verification.
              </p>
            )}
          </div>
        )}

        {stage === 'paid' && answer !== undefined && (
          <div className="play-step">
            <h3>
              <Badge tone="ok">200</Badge> Answer
            </h3>
            {answer.stub === true && (
              <div className="note note-warn">
                <p>
                  This is the <strong>stub</strong> response: the router picked{' '}
                  <Mono>{answer.model}</Mono>, but{' '}
                  {answer.modelProvider !== undefined ? (
                    <>
                      the <strong>{answer.modelProvider}</strong> provider
                    </>
                  ) : (
                    'that provider'
                  )}{' '}
                  is not configured on this server, so no model was called and no tokens were
                  used.
                </p>
              </div>
            )}
            {content !== undefined && <blockquote className="answer">{content}</blockquote>}

            <Table head={['', '']}>
              <tr>
                <td>Model</td>
                <td>
                  <Mono>{answer.model ?? '—'}</Mono>{' '}
                  <span className="muted">{answer.modelProvider}</span>
                </td>
              </tr>
              <tr>
                <td>Tokens</td>
                <td>
                  {answer.usage === undefined
                    ? 'none'
                    : `${tokens(answer.usage.prompt_tokens)} in · ${tokens(answer.usage.completion_tokens)} out · ${tokens(answer.usage.total_tokens)} total`}
                </td>
              </tr>
              <tr>
                <td>Cost</td>
                <td>
                  {answer.pricing !== undefined ? (
                    <>
                      {usd(answer.pricing.customerPriceUsd)}{' '}
                      <span className="muted small">
                        ({usd(answer.pricing.providerCostUsd)} provider +{' '}
                        {usd(answer.pricing.platformFeeUsd)} fee at{' '}
                        {answer.pricing.markupBps / 100}%)
                      </span>
                    </>
                  ) : (
                    <span className="muted">{answer.pricingUnavailable ?? 'not priced'}</span>
                  )}
                </td>
              </tr>
              <tr>
                <td>Routing</td>
                <td>
                  {answer.routing === undefined ? (
                    '—'
                  ) : (
                    <>
                      <Mono>{answer.routing.strategy}</Mono>{' '}
                      <span className="muted small">
                        {answer.routing.attempts} attempt
                        {answer.routing.attempts === 1 ? '' : 's'} · chain:{' '}
                        {(answer.routing.chain ?? []).join(' → ')}
                      </span>
                    </>
                  )}
                </td>
              </tr>
              <tr>
                <td>Metering</td>
                <td>
                  {answer.metering?.status ?? 'not metered'}
                  {answer.metering?.reason !== undefined && (
                    <span className="muted small"> — {answer.metering.reason}</span>
                  )}
                </td>
              </tr>
            </Table>

            <p className="muted small">
              This request is now on the <Link to="/dashboard">dashboard</Link>, in{' '}
              <Link to="/usage">usage</Link> and in <Link to="/payments">payments</Link>.
            </p>
          </div>
        )}
      </Card>

      <Card title="Errors you may hit">
        <Table head={['Code', 'Meaning']}>
          <tr>
            <td>
              <Mono>payment-request-expired</Mono>
            </td>
            <td>The challenge is older than five minutes. Ask for a new one and pay against it.</td>
          </tr>
          <tr>
            <td>
              <Mono>nonce-mismatch</Mono>
            </td>
            <td>The memo does not carry this challenge’s nonce, so the payment is not bound to this request.</td>
          </tr>
          <tr>
            <td>
              <Mono>payment-already-used</Mono>
            </td>
            <td>That transaction has already unlocked a request. One payment, one request.</td>
          </tr>
          <tr>
            <td>
              <Mono>UNKNOWN_CAPABILITY</Mono>
            </td>
            <td>A capability in the request matches no model. See the <Link to="/models">catalog</Link>.</td>
          </tr>
          <tr>
            <td>
              <Mono>NO_MODEL_AVAILABLE</Mono>
            </td>
            <td>Nothing satisfies the capabilities and cost ceiling together. Raise the ceiling or drop a requirement.</td>
          </tr>
        </Table>
      </Card>
    </div>
  );
}
