/**
 * Landing page.
 *
 * The pitch is fixed copy; every fact underneath it — the price, the network,
 * the asset, which providers are actually callable — is read from
 * `/v1/config` and `/v1/models` at load. If the gateway is unreachable the
 * page says so instead of showing a plausible-looking placeholder.
 */
import { Link } from 'react-router-dom';
import { api } from '../api';
import { amount, ratePerMillion, useApi } from '../hooks';
import { Badge, Card, Code, ErrorNote } from '../components/ui';

const FLOW = [
  {
    step: '1',
    title: 'Send a request',
    body: 'POST /v1/chat with your messages. No account, no signup, no key.',
  },
  {
    step: '2',
    title: 'Get a 402',
    body: 'The gateway answers HTTP 402 with an x402 challenge: who to pay, how much, and a nonce that binds the payment to this request.',
  },
  {
    step: '3',
    title: 'Pay on the XRP Ledger',
    body: 'Your wallet sends XRP or RLUSD to the receiver, carrying the nonce as a memo. Settlement is seconds and costs a fraction of a drop.',
  },
  {
    step: '4',
    title: 'Retry with proof',
    body: 'Repeat the request with an X-PAYMENT header. The facilitator verifies the transaction on-ledger before a single token is spent.',
  },
  {
    step: '5',
    title: 'Get the answer',
    body: 'The router picks the cheapest capable model, and the response carries the tokens used, the cost, and the platform fee.',
  },
];

export function Landing() {
  const config = useApi((signal) => api.config(signal));
  const models = useApi((signal) => api.models(signal));

  const cheapest = models.data?.data
    .filter((m) => m.availability === 'live' && m.inputCostPer1MTokens !== undefined)
    .sort((a, b) => (a.inputCostPer1MTokens ?? 0) - (b.inputCostPer1MTokens ?? 0))[0];

  const liveModels = models.data?.data.filter((m) => m.availability === 'live').length ?? 0;

  return (
    <div className="landing">
      <section className="hero">
        <Badge tone="accent">x402 · XRP Ledger</Badge>
        <h1>
          An AI gateway you pay <em>per request</em>.
        </h1>
        <p className="lead">
          No subscription, no API key, no invoice at the end of the month. Send a request, settle
          it in XRP or RLUSD, get the answer. The router picks the cheapest model that can do the
          job, and every request tells you exactly what it cost.
        </p>
        <div className="hero-actions">
          <Link to="/quickstart" className="btn btn-primary">
            Start building
          </Link>
          <Link to="/models" className="btn btn-ghost">
            Browse models
          </Link>
        </div>

        <dl className="hero-facts">
          <div>
            <dt>Price per request</dt>
            <dd>
              {config.data !== undefined
                ? amount(config.data.payment.amount, config.data.payment.asset)
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Network</dt>
            <dd>{config.data?.payment.network ?? '—'}</dd>
          </div>
          <div>
            <dt>Models live now</dt>
            <dd>
              {models.data !== undefined ? `${liveModels} of ${models.data.data.length}` : '—'}
            </dd>
          </div>
          <div>
            <dt>Platform fee</dt>
            <dd>
              {config.data !== undefined ? `${config.data.pricing.markupBps / 100}%` : '—'} over
              provider cost
            </dd>
          </div>
        </dl>
        {config.error !== undefined && <ErrorNote message={config.error} onRetry={config.reload} />}
      </section>

      <section className="section">
        <h2>How a paid request works</h2>
        <ol className="flow">
          {FLOW.map((f) => (
            <li key={f.step}>
              <span className="flow-step">{f.step}</span>
              <div>
                <h3>{f.title}</h3>
                <p className="muted">{f.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="section grid-2">
        <Card
          title="Providers"
          subtitle="Read live from the gateway — “live” means this server holds working credentials for it right now."
        >
          {models.error !== undefined && (
            <ErrorNote message={models.error} onRetry={models.reload} />
          )}
          {models.data !== undefined && (
            <ul className="provider-list">
              {models.data.providers.map((p) => (
                <li key={p.name}>
                  <div>
                    <strong>{p.name}</strong>
                    <span className="muted small">
                      {' '}
                      · {p.models} model{p.models === 1 ? '' : 's'}
                    </span>
                    {p.freeTier !== undefined && (
                      <div className="muted small">
                        {p.freeTier.name}: {p.freeTier.limit}
                        {p.freeTier.active ? ' (in use)' : ''}
                      </div>
                    )}
                  </div>
                  {p.availability === 'live' ? (
                    <Badge tone="ok">live</Badge>
                  ) : (
                    <Badge tone="warn">
                      {p.availabilityReason === 'no-credentials' ? 'no credentials' : 'no adapter'}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="One request, start to finish">
          <Code
            label="curl"
            code={`# 1. ask — the gateway answers 402 with the payment terms
curl -isS -X POST ${window.location.origin}/v1/chat \\
  -H 'Content-Type: application/json' \\
  -d '{"messages":[{"role":"user","content":"Say hi"}]}'

# 2. pay on the XRP Ledger, memo = hex(nonce)
# 3. retry with proof of that payment
curl -sS -X POST ${window.location.origin}/v1/chat \\
  -H 'Content-Type: application/json' \\
  -H 'X-PAYMENT: {"txHash":"<TX_HASH>","payment":<TERMS>}' \\
  -d '{"messages":[{"role":"user","content":"Say hi"}]}'`}
          />
          <p className="muted small">
            The Quickstart page runs this handshake for real, against this gateway, and shows you
            each leg of it.
          </p>
        </Card>
      </section>

      <section className="section">
        <h2>Routing you can audit</h2>
        <div className="grid-3">
          <Card title="Cheapest capable model">
            <p className="muted">
              Requests declare capabilities and an optional cost ceiling; the router ranks every
              model that qualifies by published price and takes the cheapest.
              {cheapest !== undefined && (
                <>
                  {' '}
                  Right now that is <strong>{cheapest.id}</strong> at{' '}
                  {ratePerMillion(cheapest.inputCostPer1MTokens)} prompt tokens.
                </>
              )}
            </p>
          </Card>
          <Card title="Priced from real token counts">
            <p className="muted">
              Cost comes from the provider’s own usage numbers and its published rates. When a
              provider publishes no rate, the request is reported as unpriced — never as free, and
              never as a guess.
            </p>
          </Card>
          <Card title="Paid before a token is spent">
            <p className="muted">
              Verification happens on-ledger, against the transaction you actually sent, before the
              request reaches a provider. The gateway never holds your keys and never signs for
              you.
            </p>
          </Card>
        </div>
      </section>

      <section className="cta">
        <h2>Send your first paid request</h2>
        <p className="muted">
          The quickstart walks the whole 402 flow against this gateway, then shows the usage and
          payment it produced.
        </p>
        <Link to="/quickstart" className="btn btn-primary">
          Start building
        </Link>
      </section>
    </div>
  );
}
