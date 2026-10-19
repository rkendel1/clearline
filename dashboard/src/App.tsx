import { useEffect, useState, type FormEvent } from 'react';
import { api, setToken, getToken, ApiError, type Me } from './api';
import { Overview } from './views/Overview';
import { BatchDetail } from './views/BatchDetail';
import { Exceptions } from './views/Exceptions';
import { Lineage } from './views/Lineage';
import { Contracts } from './views/Contracts';
import { Extracts, Definitions } from './views/Outputs';

type View = 'overview' | 'exceptions' | 'lineage' | 'contracts' | 'extracts' | 'definitions' | 'batch';
const DATA_ROLES: Me['role'][] = ['admin', 'operator', 'reporter'];
const NAV: { id: View; label: string; roles: Me['role'][] }[] = [
  { id: 'overview', label: 'Overview', roles: DATA_ROLES },
  { id: 'exceptions', label: 'Exceptions', roles: DATA_ROLES },
  { id: 'lineage', label: 'Lineage', roles: ['admin', 'operator'] },
  { id: 'contracts', label: 'Contracts', roles: [...DATA_ROLES, 'approver'] },
  { id: 'extracts', label: 'Extracts', roles: DATA_ROLES },
  { id: 'definitions', label: 'Metric definitions', roles: DATA_ROLES },
];

// Hash routing keeps the server simple: #/overview, #/batch/<id>
function parseHash(): { view: View; arg?: string } {
  const [, v, arg] = window.location.hash.split('/');
  return { view: (NAV.some((n) => n.id === v) || v === 'batch' ? v : 'overview') as View, arg };
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(!!getToken());
  const [route, setRoute] = useState(parseHash());

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    if (!getToken()) return;
    api<Me>('/api/v1/me').then(setMe).catch(() => setToken(null)).finally(() => setChecking(false));
  }, []);

  const go = (view: View, arg?: string) => { window.location.hash = `/${view}${arg ? `/${arg}` : ''}`; };
  const signOut = () => { setToken(null); setMe(null); };

  if (checking) return <main className="signin"><p>Checking your session…</p></main>;
  if (!me) return <SignIn onSignedIn={setMe} />;
  if (!me.tenant_id) return (
    <main className="signin"><h1>Platform administrator</h1><p>This token can create tenants and issue tokens through the API, but by design it has no access to tenant data. Sign in with a tenant token to use the dashboard.</p><button className="btn" onClick={signOut}>Sign out</button></main>
  );
  const tenant = me.tenant_id;
  const openBatch = (id: string) => go('batch', id);
  // Approvers see no tenant data: they always get the only view they can use (no redirect side effects).
  const view: View = me.role === 'approver' ? 'contracts' : route.view;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><span className="mark" aria-hidden="true" /> Clearline</div>
        <p className="who"><strong>{tenant}</strong><span>{me.actor}, {me.role}</span></p>
        <nav aria-label="Views">
          {NAV.filter((n) => n.roles.includes(me.role)).map((n) => (
            <a key={n.id} href={`#/${n.id}`} aria-current={view === n.id ? 'page' : undefined}>{n.label}</a>
          ))}
        </nav>
        <button className="link signout" onClick={signOut}>Sign out</button>
        <p className="synthetic">Synthetic data only. Not for real member information.</p>
      </aside>
      <main className="content" id="main">
        {view === 'overview' && <Overview tenant={tenant} onOpenBatch={openBatch} />}
        {view === 'batch' && route.arg && <BatchDetail tenant={tenant} id={route.arg} me={me} onBack={() => go('overview')} />}
        {view === 'exceptions' && <Exceptions tenant={tenant} me={me} onOpenBatch={openBatch} />}
        {view === 'lineage' && <Lineage tenant={tenant} onOpenBatch={openBatch} />}
        {view === 'contracts' && <Contracts tenant={tenant} me={me} />}
        {view === 'extracts' && <Extracts tenant={tenant} me={me} />}
        {view === 'definitions' && <Definitions tenant={tenant} />}
      </main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (m: Me) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setToken(value.trim());
    try { onSignedIn(await api<Me>('/api/v1/me')); }
    catch (err) { setToken(null); setError(err instanceof ApiError && err.status === 401 ? 'That token is not valid or has been revoked.' : (err as Error).message); }
  };
  return (
    <main className="signin">
      <div className="brand"><span className="mark" aria-hidden="true" /> Clearline</div>
      <h1>Sign in with an API token</h1>
      <p>Your token decides which tenant you see and what you can do. It is kept for this browser tab only.</p>
      <form onSubmit={submit}>
        <label htmlFor="token">API token</label>
        <input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="cl_…" required />
        <button className="btn" type="submit">Sign in</button>
      </form>
      {error && <p className="note note-bad" role="alert">{error}</p>}
      <p className="muted small">Running the local demo? The seeded demo tokens are listed in the README.</p>
    </main>
  );
}
