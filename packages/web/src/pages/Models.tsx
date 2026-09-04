/**
 * Model catalog: model, provider, capability, price, availability, free/paid.
 *
 * The rates are the providers' published per-token prices as recorded in
 * router-core. A provider that publishes none shows "not published" — the page
 * never fills that gap with a zero or with the word "free".
 */
import { useMemo, useState } from 'react';
import { api, type CatalogModel } from '../api';
import { ratePerMillion, tokens, useApi } from '../hooks';
import { Badge, Card, ErrorNote, Loading, Mono, PageHead, Table } from '../components/ui';

function availabilityBadge(model: CatalogModel) {
  if (model.availability === 'live') return <Badge tone="ok">live</Badge>;
  return (
    <Badge tone="warn">
      {model.availabilityReason === 'no-credentials' ? 'no credentials' : 'no adapter'}
    </Badge>
  );
}

/**
 * "Free" here means the provider's own tier is free AND this server is using
 * it. It never means the caller pays nothing: the x402 price is charged either
 * way, which is what the footnote on this page says.
 */
function priceBadge(model: CatalogModel) {
  if (model.freeTier?.active === true) return <Badge tone="accent">free tier</Badge>;
  if (model.pricing === 'published') return <Badge tone="neutral">paid</Badge>;
  if (model.pricing === 'prompt-only') return <Badge tone="warn">partly priced</Badge>;
  return <Badge tone="warn">price unknown</Badge>;
}

export function Models() {
  const models = useApi((signal) => api.models(signal));
  const config = useApi((signal) => api.config(signal));
  const [provider, setProvider] = useState('all');
  const [liveOnly, setLiveOnly] = useState(false);

  const rows = useMemo(() => {
    const all = models.data?.data ?? [];
    return all.filter(
      (m) =>
        (provider === 'all' || m.provider === provider) &&
        (!liveOnly || m.availability === 'live')
    );
  }, [models.data, provider, liveOnly]);

  return (
    <div className="page">
      <PageHead
        title="Models"
        lead="Everything the router can choose from, with the price it ranks on and whether this gateway can call it right now."
        actions={
          <button type="button" className="btn btn-ghost" onClick={models.reload}>
            Refresh
          </button>
        }
      />

      {models.error !== undefined && <ErrorNote message={models.error} onRetry={models.reload} />}
      {models.loading && models.data === undefined && <Loading what="the catalog" />}

      {models.data !== undefined && (
        <>
          <div className="filters">
            <label>
              Provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="all">All providers</option>
                {models.data.providers.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={liveOnly}
                onChange={(e) => setLiveOnly(e.target.checked)}
              />
              Callable right now
            </label>
            <span className="muted small">
              {rows.length} of {models.data.data.length} models
            </span>
          </div>

          <Card>
            <Table
              head={[
                'Model',
                'Provider',
                'Capabilities',
                'Input / 1M',
                'Output / 1M',
                'Context',
                'Availability',
                'Price',
              ]}
            >
              {rows.map((m) => (
                <tr key={`${m.provider}:${m.id}`}>
                  <td>
                    <Mono>{m.id}</Mono>
                  </td>
                  <td>
                    {m.provider}
                    {m.freeTier !== undefined && (
                      <div className="muted small">{m.freeTier.limit}</div>
                    )}
                  </td>
                  <td>
                    <div className="chips">
                      {m.capabilities.map((c) => (
                        <span key={c} className="chip">
                          {c}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="nowrap">{ratePerMillion(m.inputCostPer1MTokens)}</td>
                  <td className="nowrap">{ratePerMillion(m.outputCostPer1MTokens)}</td>
                  <td className="nowrap">{tokens(m.contextWindow)}</td>
                  <td>{availabilityBadge(m)}</td>
                  <td>{priceBadge(m)}</td>
                </tr>
              ))}
            </Table>
            {rows.length === 0 && <p className="muted pad">No model matches those filters.</p>}
          </Card>

          <Card title="How to read this table">
            <ul className="notes">
              <li>
                <strong>live</strong> means this server holds working credentials for the provider
                and a real answer comes back. <strong>no credentials</strong> means the adapter
                exists but is unconfigured, and <strong>no adapter</strong> means this build cannot
                call the provider at all — in both cases a routed request gets a placeholder
                response flagged <Mono>stub: true</Mono>.
              </li>
              <li>
                <strong>not published</strong> is exactly that: the provider publishes no
                per-token rate, so requests through that model are metered but reported as
                unpriced. Models with an unknown price rank last and are skipped when a request
                sets a cost ceiling.
              </li>
              <li>
                A <strong>free tier</strong> is the provider’s tier, not yours. You still pay the
                gateway{' '}
                {config.data !== undefined
                  ? `${config.data.payment.amount} ${config.data.payment.asset === 'XRP' ? 'drops' : config.data.payment.asset}`
                  : 'the x402 price'}{' '}
                per request — it is what buys the route.
              </li>
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
