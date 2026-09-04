/** Small presentational pieces the pages share. No page-specific logic here. */
import { useState, type ReactNode } from 'react';

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-head">
          <div>
            {title !== undefined && <h2>{title}</h2>}
            {subtitle !== undefined && <p className="muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {hint !== undefined && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

/**
 * The three states every data page has. Kept in one place so "nothing here
 * yet" never gets confused with "the gateway is down" on any page.
 */
export function Loading({ what }: { what: string }) {
  return <p className="muted pad">Loading {what}…</p>;
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="note note-bad">
      <p>
        <strong>Could not reach the gateway.</strong> {message}
      </p>
      <p className="muted">
        The console reads the live API and shows nothing when it cannot. Check that the server is
        running and that the console is served from the same origin (or proxied to it).
      </p>
      {onRetry !== undefined && (
        <button type="button" className="btn btn-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted pad">{children}</p>;
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {/* Indexed: a definition table passes blank headings, which collide as keys. */}
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Monospace value that keeps long hashes and addresses from breaking layout. */
export function Mono({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <code className="mono" title={title}>
      {children}
    </code>
  );
}

export function Code({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false)
    );
  };
  return (
    <div className="code">
      <div className="code-head">
        <span className="muted">{label ?? 'shell'}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Page header: title, one line of purpose, optional actions. */
export function PageHead({
  title,
  lead,
  actions,
}: {
  title: string;
  lead: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
      </div>
      {actions}
    </header>
  );
}

/** Says out loud that the ledger is a rolling in-memory window. */
export function RetentionNote({
  retained,
  persistence,
}: {
  retained: number;
  persistence: string;
}) {
  return (
    <p className="muted small">
      Showing the {retained} most recent request{retained === 1 ? '' : 's'} held in{' '}
      {persistence === 'memory' ? 'the gateway’s in-memory window' : persistence}. This window is
      cleared when the server restarts — OpenMeter holds the durable usage record.
    </p>
  );
}
