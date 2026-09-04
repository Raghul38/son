/**
 * The console shell: navigation, routes, and the one line of status that says
 * whether the gateway is actually answering.
 */
import { useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useApi } from './hooks';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { Models } from './pages/Models';
import { Payments } from './pages/Payments';
import { Usage } from './pages/Usage';
import { Quickstart } from './pages/Quickstart';
import { Keys } from './pages/Keys';
import { NotFound } from './pages/NotFound';

const NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/models', label: 'Models' },
  { to: '/usage', label: 'Usage' },
  { to: '/payments', label: 'Payments' },
  { to: '/quickstart', label: 'Quickstart' },
  { to: '/keys', label: 'API keys' },
];

function Nav() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const close = () => setOpen(false);

  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link to="/" className="brand" onClick={close}>
          <span className="brand-mark" aria-hidden="true" />
          Sonpay
        </Link>
        <button
          type="button"
          className="nav-toggle"
          aria-expanded={open}
          aria-label="Toggle navigation"
          onClick={() => setOpen((o) => !o)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <div className={`nav-links${open ? ' open' : ''}`}>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => (isActive ? 'nav-link active' : 'nav-link')}
              onClick={close}
            >
              {item.label}
            </NavLink>
          ))}
          {location.pathname !== '/quickstart' && (
            <Link to="/quickstart" className="btn btn-primary btn-sm nav-cta" onClick={close}>
              Start building
            </Link>
          )}
        </div>
      </div>
    </nav>
  );
}

/** Footer status line — the live network/asset, or the fact that we cannot see it. */
function StatusBar() {
  const { data, error } = useApi((signal) => api.config(signal));

  return (
    <footer className="footer">
      <div className="footer-inner">
        <span>
          Sonpay — an AI gateway you pay per request, settled on the XRP Ledger over x402.
        </span>
        <span className="footer-status">
          {error !== undefined && <span className="dot dot-bad" title={error} />}
          {error !== undefined && 'gateway unreachable'}
          {data !== undefined && <span className="dot dot-ok" />}
          {data !== undefined &&
            `${data.payment.network} · ${data.payment.asset} · facilitator: ${data.payment.facilitator}`}
        </span>
      </div>
    </footer>
  );
}

export function App() {
  return (
    <div className="app">
      <Nav />
      <main className="main">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/models" element={<Models />} />
          <Route path="/usage" element={<Usage />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/quickstart" element={<Quickstart />} />
          <Route path="/keys" element={<Keys />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <StatusBar />
    </div>
  );
}
