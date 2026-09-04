/**
 * Developer dashboard: requests, token usage, provider, estimated cost,
 * platform fee and payment status — all from the gateway's own request ledger.
 */
import { Link } from 'react-router-dom';
import { api, type ActivityRecord } from '../api';
import { time, tokens, usd, useApi, shorten } from '../hooks';
import {
  Badge,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Mono,
  PageHead,
  RetentionNote,
  Stat,
  Table,
} from '../components/ui';

export function outcomeBadge(record: Pick<ActivityRecord, 'outcome' | 'error'>) {
  switch (record.outcome) {
    case 'served':
      return <Badge tone="ok">served</Badge>;
    case 'stub':
      return <Badge tone="warn">stub</Badge>;
    case 'payment-required':
      return <Badge tone="neutral">402 challenge</Badge>;
    case 'payment-rejected':
      return <Badge tone="bad">payment rejected</Badge>;
    default:
      return <Badge tone="bad">{record.error ?? 'error'}</Badge>;
  }
}

function paymentBadge(status: 'none' | 'verified' | 'rejected') {
  if (status === 'verified') return <Badge tone="ok">verified</Badge>;
  if (status === 'rejected') return <Badge tone="bad">rejected</Badge>;
  return <Badge tone="neutral">unpaid</Badge>;
}

export function Dashboard() {
  const activity = useApi((signal) => api.activity(100, signal));
  const config = useApi((signal) => api.config(signal));

  const summary = activity.data?.summary;
  const markup = config.data?.pricing.markupBps;

  return (
    <div className="page">
      <PageHead
        title="Dashboard"
        lead="Every request this gateway has handled since it started, with what it cost and whether it was paid for."
        actions={
          <button type="button" className="btn btn-ghost" onClick={activity.reload}>
            Refresh
          </button>
        }
      />

      {activity.error !== undefined && (
        <ErrorNote message={activity.error} onRetry={activity.reload} />
      )}
      {activity.loading && activity.data === undefined && <Loading what="activity" />}

      {summary !== undefined && (
        <>
          <div className="stats">
            <Stat
              label="Requests"
              value={summary.requests}
              hint={`${summary.served} served · ${summary.stub} stub`}
            />
            <Stat
              label="Tokens"
              value={tokens(summary.totalTokens)}
              hint={`${tokens(summary.inputTokens)} in · ${tokens(summary.outputTokens)} out`}
            />
            <Stat
              label="Provider cost"
              value={usd(summary.providerCostUsd)}
              hint={
                summary.unpricedRequests > 0
                  ? `${summary.unpricedRequests} request(s) had no published rate`
                  : 'from published per-token rates'
              }
            />
            <Stat
              label="Platform fee"
              value={usd(summary.platformFeeUsd)}
              hint={markup !== undefined ? `${markup / 100}% markup` : undefined}
            />
            <Stat
              label="Charged to callers"
              value={usd(summary.customerPriceUsd)}
              hint="provider cost + fee"
            />
            <Stat
              label="Payments verified"
              value={summary.verifiedPayments}
              hint={`${summary.attributedPayers} distinct payer(s)`}
            />
          </div>

          <div className="grid-2">
            <Card title="By provider">
              {summary.byProvider.length === 0 ? (
                <Empty>No request has reached a provider yet.</Empty>
              ) : (
                <Table head={['Provider', 'Requests', 'Tokens']}>
                  {summary.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td>{p.provider}</td>
                      <td>{p.requests}</td>
                      <td>{tokens(p.totalTokens)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
            <Card title="By model">
              {summary.byModel.length === 0 ? (
                <Empty>No model has answered yet.</Empty>
              ) : (
                <Table head={['Model', 'Requests', 'Tokens']}>
                  {summary.byModel.map((m) => (
                    <tr key={m.model}>
                      <td>
                        <Mono>{m.model}</Mono>
                      </td>
                      <td>{m.requests}</td>
                      <td>{tokens(m.totalTokens)}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </Card>
          </div>
        </>
      )}

      <Card
        title="Recent requests"
        subtitle="Newest first. A 402 is a request too — it is how the flow starts."
      >
        {activity.data !== undefined && activity.data.data.length === 0 ? (
          <Empty>
            Nothing yet. <Link to="/quickstart">Send a request from the quickstart</Link> and it
            will appear here.
          </Empty>
        ) : (
          activity.data !== undefined && (
            <>
              <Table
                head={[
                  'Time',
                  'Outcome',
                  'Model',
                  'Provider',
                  'Tokens',
                  'Cost',
                  'Fee',
                  'Payment',
                  'Latency',
                ]}
              >
                {activity.data.data.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{time(r.at)}</td>
                    <td>{outcomeBadge(r)}</td>
                    <td>{r.model !== undefined ? <Mono>{r.model}</Mono> : '—'}</td>
                    <td>{r.provider ?? '—'}</td>
                    <td>{tokens(r.usage?.totalTokens)}</td>
                    <td title={r.pricingUnavailable}>
                      {r.pricing !== undefined
                        ? usd(r.pricing.providerCostUsd)
                        : r.usage?.totalTokens !== undefined
                          ? 'unpriced'
                          : '—'}
                    </td>
                    <td>{r.pricing !== undefined ? usd(r.pricing.platformFeeUsd) : '—'}</td>
                    <td>
                      {paymentBadge(r.payment.status)}
                      {r.payment.payer !== undefined && (
                        <div className="muted small">
                          <Mono title={r.payment.payer}>{shorten(r.payment.payer)}</Mono>
                        </div>
                      )}
                    </td>
                    <td className="nowrap">{r.latencyMs} ms</td>
                  </tr>
                ))}
              </Table>
              <RetentionNote
                retained={activity.data.retention.retained}
                persistence={activity.data.retention.persistence}
              />
            </>
          )
        )}
      </Card>
    </div>
  );
}
