/**
 * API keys.
 *
 * This gateway has no key store: access is granted by a verified payment and
 * nothing else. The page reads `/v1/keys` and reports whatever the backend
 * says — if a future build gains a key store, the list and the create/revoke
 * controls here start working without a change to this file's contract.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApi } from '../hooks';
import { Badge, Card, Empty, ErrorNote, Loading, Mono, PageHead, Table } from '../components/ui';

export function Keys() {
  const keys = useApi((signal) => api.keys(signal));
  const [name, setName] = useState('');
  const [result, setResult] = useState<string | undefined>();

  /**
   * Attempt a create against the real endpoint. On this build it returns 501,
   * and the page prints that verbatim — it does not mint a fake key to make
   * the form feel like it worked.
   */
  const create = async () => {
    setResult(undefined);
    const res = await fetch('/v1/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    setResult(`HTTP ${res.status} — ${message}`);
    keys.reload();
  };

  const supported = keys.data?.supported === true;

  return (
    <div className="page">
      <PageHead
        title="API keys"
        lead="Optional by design — an x402 caller never needs one."
        actions={
          <button type="button" className="btn btn-ghost" onClick={keys.reload}>
            Refresh
          </button>
        }
      />

      {keys.error !== undefined && <ErrorNote message={keys.error} onRetry={keys.reload} />}
      {keys.loading && keys.data === undefined && <Loading what="keys" />}

      {keys.data !== undefined && (
        <>
          <Card
            title="Status"
            actions={
              supported ? <Badge tone="ok">enabled</Badge> : <Badge tone="neutral">not issued</Badge>
            }
          >
            <p className="muted">{keys.data.reason}</p>
            {!supported && (
              <p className="muted">
                There is nothing to lose, rotate or leak here. Authorisation is a payment on the
                XRP Ledger, verified per request, and it expires the moment that request is
                served. Head to the <Link to="/quickstart">quickstart</Link> to make one.
              </p>
            )}
          </Card>

          <Card title="Your keys">
            {keys.data.data.length === 0 ? (
              <Empty>
                {supported
                  ? 'No keys yet.'
                  : 'This gateway issues no keys, so there are none to list.'}
              </Empty>
            ) : (
              <Table head={['Name', 'ID', 'Created']}>
                {keys.data.data.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td>
                      <Mono>{k.id}</Mono>
                    </td>
                    <td>{new Date(k.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          <Card
            title="Create a key"
            subtitle="The form posts to the real endpoint and prints exactly what it answers."
          >
            <div className="row">
              <label className="field grow">
                <span>Name</span>
                <input
                  value={name}
                  placeholder="ci-pipeline"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void create()}
                disabled={name.trim() === ''}
              >
                Create key
              </button>
            </div>
            {result !== undefined && (
              <div className={`note ${supported ? '' : 'note-warn'}`}>
                <p>
                  <Mono>{result}</Mono>
                </p>
              </div>
            )}
            <p className="muted small">
              If this gateway ever does issue keys, the secret will be shown once, at creation, and
              never again — not on this page, not through the API. Store it when you see it.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
