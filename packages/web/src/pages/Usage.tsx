/**
 * Usage: input tokens, output tokens, total tokens, model/provider and the
 * request id — the same id the gateway sends to OpenMeter, so a row here can
 * be reconciled against the meter.
 */
import { api } from '../api';
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

function meteringBadge(metering: { status: string; reason?: string } | undefined) {
  if (metering === undefined) return <Badge tone="neutral">not metered</Badge>;
  if (metering.status === 'sent') return <Badge tone="ok">metered</Badge>;
  if (metering.status === 'disabled') return <Badge tone="neutral">metering off</Badge>;
  return (
    <Badge tone="bad">
      <span title={metering.reason}>{metering.status}</span>
    </Badge>
  );
}

export function Usage() {
  const activity = useApi((signal) => api.activity(100, signal));
  const config = useApi((signal) => api.config(signal));

  // Only requests that actually burned tokens belong on a usage page.
  const rows = (activity.data?.data ?? []).filter((r) => r.usage !== undefined);
  const summary = activity.data?.summary;

  return (
    <div className="page">
      <PageHead
        title="Usage"
        lead="Token usage per request, as reported by the provider and metered to OpenMeter."
        actions={
          <button type="button" className="btn btn-ghost" onClick={activity.reload}>
            Refresh
          </button>
        }
      />

      {activity.error !== undefined && (
        <ErrorNote message={activity.error} onRetry={activity.reload} />
      )}
      {activity.loading && activity.data === undefined && <Loading what="usage" />}

      {summary !== undefined && (
        <div className="stats">
          <Stat label="Input tokens" value={tokens(summary.inputTokens)} />
          <Stat label="Output tokens" value={tokens(summary.outputTokens)} />
          <Stat label="Total tokens" value={tokens(summary.totalTokens)} />
          <Stat
            label="Metered events"
            value={summary.meteredEvents}
            hint={
              config.data?.metering.enabled === true
                ? `source: ${config.data.metering.source}`
                : 'metering is not configured'
            }
          />
          <Stat
            label="Unpriced requests"
            value={summary.unpricedRequests}
            hint="tokens used, no published rate"
          />
        </div>
      )}

      {activity.data !== undefined && (
        <Card
          title="Per request"
          subtitle="One row per request that used tokens. Requests answered by the stub used none and are not listed."
        >
          {rows.length === 0 ? (
            <Empty>No tokens have been used yet.</Empty>
          ) : (
            <>
              <Table
                head={[
                  'Time',
                  'Request ID',
                  'Model',
                  'Provider',
                  'Input',
                  'Output',
                  'Total',
                  'Cost',
                  'Metered',
                ]}
              >
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="nowrap">{time(r.at)}</td>
                    <td>
                      {r.requestId === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        <Mono title={r.requestId}>{shorten(r.requestId, 14, 8)}</Mono>
                      )}
                    </td>
                    <td>{r.model !== undefined ? <Mono>{r.model}</Mono> : '—'}</td>
                    <td>{r.provider ?? '—'}</td>
                    <td>{tokens(r.usage?.inputTokens)}</td>
                    <td>{tokens(r.usage?.outputTokens)}</td>
                    <td>
                      <strong>{tokens(r.usage?.totalTokens)}</strong>
                    </td>
                    <td title={r.pricingUnavailable}>
                      {r.pricing !== undefined ? usd(r.pricing.customerPriceUsd) : 'unpriced'}
                    </td>
                    <td>
                      {meteringBadge(r.metering)}
                      {r.metering?.customer !== undefined && (
                        <div className="muted small">customer: {r.metering.customer}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
              <RetentionNote
                retained={activity.data.retention.retained}
                persistence={activity.data.retention.persistence}
              />
            </>
          )}
        </Card>
      )}

      <Card title="How usage is counted">
        <ul className="notes">
          <li>
            Token counts are the provider’s, taken from the completion response. The gateway does
            not estimate them, and a response without a usage block is reported without one.
          </li>
          <li>
            The <strong>request ID</strong> is derived from the verified payment, so the same
            payment always produces the same id. Replaying a payment cannot double-count usage:
            OpenMeter deduplicates on that id.
          </li>
          <li>
            <strong>Cost</strong> is the caller price — provider cost plus the platform markup —
            and appears only when the provider publishes both a prompt and a completion rate.
            Otherwise the row reads <em>unpriced</em>, and the tokens are still metered.
          </li>
        </ul>
      </Card>
    </div>
  );
}
