/**
 * Payments: asset, amount, transaction hash and status for every payment the
 * gateway has been shown, straight from `/v1/payments`.
 */
import { api, type PaymentRecord } from '../api';
import { amount, shorten, time, tokens, usd, useApi } from '../hooks';
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

function statusBadge(status: PaymentRecord['status']) {
  if (status === 'verified') return <Badge tone="ok">verified on-ledger</Badge>;
  if (status === 'rejected') return <Badge tone="bad">rejected</Badge>;
  return <Badge tone="neutral">challenge issued</Badge>;
}

/** Link a hash to a public explorer, but only for a network we can name. */
function explorer(network: string, txHash: string): string | undefined {
  if (network === 'xrpl:1') return `https://testnet.xrpl.org/transactions/${txHash}`;
  if (network === 'xrpl:0') return `https://livenet.xrpl.org/transactions/${txHash}`;
  return undefined;
}

export function Payments() {
  const payments = useApi((signal) => api.payments(100, signal));
  const config = useApi((signal) => api.config(signal));

  const rows = payments.data?.data ?? [];
  const verified = rows.filter((p) => p.status === 'verified');
  const settled = verified.reduce((sum, p) => sum + Number(p.amount ?? 0), 0);

  return (
    <div className="page">
      <PageHead
        title="Payments"
        lead="Every x402 payment presented to this gateway — verified, rejected, or still an open challenge."
        actions={
          <button type="button" className="btn btn-ghost" onClick={payments.reload}>
            Refresh
          </button>
        }
      />

      {payments.error !== undefined && (
        <ErrorNote message={payments.error} onRetry={payments.reload} />
      )}
      {payments.loading && payments.data === undefined && <Loading what="payments" />}

      {payments.data !== undefined && (
        <>
          <div className="stats">
            <Stat label="Verified payments" value={verified.length} />
            <Stat
              label="Settled"
              value={
                config.data !== undefined
                  ? amount(String(settled), config.data.payment.asset)
                  : String(settled)
              }
              hint={config.data?.payment.network}
            />
            <Stat
              label="Rejected"
              value={rows.filter((p) => p.status === 'rejected').length}
              hint="presented but not verifiable on-ledger"
            />
            <Stat
              label="Receiver"
              value={
                config.data !== undefined ? (
                  <Mono title={config.data.payment.receiver}>
                    {shorten(config.data.payment.receiver, 10, 6)}
                  </Mono>
                ) : (
                  '—'
                )
              }
              hint={config.data?.payment.facilitator}
            />
          </div>

          <Card title="Payment history">
            {rows.length === 0 ? (
              <Empty>No payment has been presented to this gateway yet.</Empty>
            ) : (
              <>
                <Table
                  head={[
                    'Time',
                    'Status',
                    'Asset',
                    'Amount',
                    'Transaction',
                    'Payer',
                    'Bought',
                    'Charged',
                  ]}
                >
                  {rows.map((p) => {
                    const url = p.txHash !== undefined ? explorer(p.network, p.txHash) : undefined;
                    return (
                      <tr key={p.id}>
                        <td className="nowrap">{time(p.at)}</td>
                        <td>{statusBadge(p.status)}</td>
                        <td>{p.asset}</td>
                        <td className="nowrap">{amount(p.amount, p.asset)}</td>
                        <td>
                          {p.txHash === undefined ? (
                            '—'
                          ) : url !== undefined ? (
                            <a href={url} target="_blank" rel="noreferrer">
                              <Mono title={p.txHash}>{shorten(p.txHash, 10, 8)}</Mono>
                            </a>
                          ) : (
                            <Mono title={p.txHash}>{shorten(p.txHash, 10, 8)}</Mono>
                          )}
                        </td>
                        <td>
                          {p.payer === undefined ? (
                            <span className="muted">unattributed</span>
                          ) : (
                            <Mono title={p.payer}>{shorten(p.payer, 8, 6)}</Mono>
                          )}
                        </td>
                        <td>
                          {p.model === undefined ? (
                            '—'
                          ) : (
                            <>
                              <Mono>{p.model}</Mono>
                              <div className="muted small">{tokens(p.totalTokens)} tokens</div>
                            </>
                          )}
                        </td>
                        <td className="nowrap">{usd(p.customerPriceUsd)}</td>
                      </tr>
                    );
                  })}
                </Table>
                <RetentionNote
                  retained={payments.data.retention.retained}
                  persistence={payments.data.retention.persistence}
                />
              </>
            )}
          </Card>

          <Card title="What “verified” means here">
            <p className="muted">
              A payment is verified by fetching the transaction from the ledger and checking it
              end to end: it is in a validated ledger, it is a Payment, the destination is this
              gateway’s receiver, the amount is exact, the network matches, and its memo carries
              the nonce from the challenge being answered. A hash that has already been spent is
              refused. Nothing about a payment on this page was reported by the caller — the
              caller supplies only the hash.
            </p>
            <p className="muted small">
              “Charged” is what the gateway billed for the AI work in USD (provider cost plus the
              platform fee). It is separate from the{' '}
              {config.data !== undefined
                ? amount(config.data.payment.amount, config.data.payment.asset)
                : 'x402'}{' '}
              access price paid on-ledger.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
