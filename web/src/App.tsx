import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { request, session, t, type Me } from './lib/api';
import { href, useRoute } from './lib/router';
import { useLoad } from './lib/useLoad';
import { SignIn } from './views/SignIn';
import { Overview } from './views/Overview';
import { Batches } from './views/Batches';
import { Exceptions } from './views/Exceptions';
import { Records } from './views/Records';
import { Lineage } from './views/Lineage';
import { Contracts } from './views/Contracts';
import { Metrics } from './views/Metrics';
import { Extracts } from './views/Extracts';
import { Audit } from './views/Audit';
import { Fields } from './views/Fields';
import { Tokens } from './views/Tokens';
import { Platform } from './views/Platform';
import { Workspace } from './views/Workspace';
import { History } from './views/History';
import { Library } from './views/Library';
import { Runs } from './views/Runs';
import { Run } from './views/Run';
import { Destinations } from './views/Destinations';
import { Notifications } from './views/Notifications';
import type { Notifications as NotificationList } from './types';
import { Note } from './ui';
import { Landing } from './landing/Landing';
import { Source } from './landing/Source';
import { Assistant } from './landing/Assistant';
import { useRoute as useHashRoute } from './lib/router';

interface Item { key: string; label: string; perm: string; render: () => ReactNode; badge?: number }

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [expired, setExpired] = useState(false);
  const signOut = useCallback(() => { session.signOut(); setMe(null); window.location.hash = ''; }, []);
  useEffect(() => { session.onUnauthorized(() => { session.signOut(); setMe(null); setExpired(true); }); return () => session.onUnauthorized(null); }, []);
  if (!me) return <Public expired={expired} onSignedIn={(m) => { setExpired(false); setMe(m); window.location.hash = '#/'; }} />;
  return <Shell me={me} onSignOut={signOut} />;
}

/** Before sign-in: the public architecture walkthrough and assistant. Nothing here needs an account. */
function Public({ expired, onSignedIn }: { expired: boolean; onSignedIn: (m: Me) => void }) {
  const r = useHashRoute();
  const page = r.path[0];
  return (
    <>
      {page === 'signin' || expired ? <SignIn expired={expired} onSignedIn={onSignedIn} /> : page === 'source' ? <Source /> : <Landing />}
      <Assistant />
    </>
  );
}

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const hasTenant = !!me.tenant_id;
  const unread = useLoad((s) => (hasTenant && session.can('notification:read') ? request<NotificationList>('GET', t('/notifications?unread=true&limit=1'), undefined, { signal: s }) : Promise.resolve(null)), [route.path[0]]);
  const badge = unread.data?.unread ?? 0;

  const groups: { title: string; items: Item[] }[] = [
    { title: 'Data', items: [
      { key: '', label: 'Overview', perm: 'report:read', render: () => <Overview /> },
      { key: 'batches', label: 'Batches', perm: 'batch:read', render: () => <Batches id={route.path[1]} /> },
      { key: 'exceptions', label: 'Exceptions', perm: 'quarantine:read', render: () => <Exceptions /> },
      { key: 'records', label: 'Records', perm: 'record:read', render: () => <Records entity={route.path[1]} /> },
      { key: 'lineage', label: 'Lineage', perm: 'lineage:read', render: () => <Lineage entity={route.path[1]} recordKey={route.path[2]} /> },
      { key: 'extracts', label: 'Extracts', perm: 'extract:run', render: () => <Extracts /> },
    ] },
    { title: 'Query', items: [
      { key: 'query', label: 'Workspace', perm: 'query:propose', render: () => <Workspace seed={route.query.get('proposal')} /> },
      { key: 'history', label: 'History', perm: 'query:history', render: () => <History /> },
    ] },
    { title: 'Saved analytics', items: [
      { key: 'saved', label: 'Saved queries', perm: 'saved_query:read', render: () => <Library id={route.path[1]} tab={route.query.get('tab')} /> },
      { key: 'runs', label: 'Run history', perm: 'saved_query:read', render: () => (route.path[1] ? <Run id={route.path[1]} /> : <Runs />) },
      { key: 'notifications', label: 'Notifications', perm: 'notification:read', badge, render: () => <Notifications onChange={unread.reload} /> },
      { key: 'destinations', label: 'Delivery', perm: 'schedule:manage', render: () => <Destinations /> },
    ] },
    { title: 'Governance', items: [
      { key: 'contracts', label: 'Contracts', perm: 'contract:read', render: () => <Contracts /> },
      { key: 'metrics', label: 'Metric definitions', perm: 'report:read', render: () => <Metrics /> },
      { key: 'fields', label: 'Field policies', perm: 'policy:read', render: () => <Fields /> },
      { key: 'audit', label: 'Audit trail', perm: 'audit:read', render: () => <Audit /> },
      { key: 'tokens', label: 'API tokens', perm: 'token:issue', render: () => <Tokens /> },
    ] },
  ];
  const visible = groups.map((g) => ({ ...g, items: hasTenant ? g.items.filter((i) => session.can(i.perm)) : [] })).filter((g) => g.items.length);
  const all = visible.flatMap((g) => g.items);
  const current = all.find((i) => i.key === (route.path[0] ?? ''));
  const platform = me.role === 'platform_admin';
  const fallback = all.length ? all[0] : null;

  return (
    <div className="shell">
      <nav className={`nav${open ? '' : ' closed'}`} aria-label="Main">
        <div className="row"><div className="brand grow">Clearline</div><button className="btn menu-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>Menu</button></div>
        <div className="groups" onClick={() => setOpen(false)}>
          <a href={href('about')} className={route.path[0] === 'about' ? 'active' : ''}>Architecture</a>
          {platform && <a href={href('platform')} className={route.path[0] === 'platform' ? 'active' : ''}>Platform</a>}
          {visible.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((i) => <a key={i.key} href={i.key ? href(i.key) : '#/'} className={(route.path[0] ?? '') === i.key ? 'active' : ''}>{i.label}{i.badge ? <span className="badge" aria-label={`${i.badge} unread`}>{i.badge}</span> : null}</a>)}
            </div>
          ))}
          <div className="who">
            <div><strong>{me.actor}</strong></div>
            <div className="muted">{me.role}{me.tenant_id ? ` · ${me.tenant_id}` : ''}</div>
            <button className="btn" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </nav>
      <main className="main" id="main">
        {route.path[0] === 'about' ? <Landing embedded /> : route.path[0] === 'source' ? <Source /> :
          platform && route.path[0] === 'platform' ? <Platform /> :
          current ? current.render() :
          route.path[0] && route.path[0] !== '' ? <Note tone="warn">There is nothing at <code>#{route.path.join('/')}</code>, or your role cannot see it.</Note> :
          fallback ? fallback.render() :
          platform ? <Platform /> : <Note tone="warn">This token has no permissions to view data in the web interface.</Note>}
      </main>
      <Assistant view={route.path[0] ?? ''} />
    </div>
  );
}
