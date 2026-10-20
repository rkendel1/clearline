import { request, t } from '../lib/api';
import { when } from '../lib/format';
import { go } from '../lib/router';
import { useAction, useLoad } from '../lib/useLoad';
import type { Notifications as List } from '../types';
import { Async, Button, ErrorBox, Page, Section, Signal } from '../ui';

export function Notifications({ onChange }: { onChange: () => void }) {
  const load = useLoad((s) => request<List>('GET', t('/notifications?limit=100'), undefined, { signal: s }), []);
  const mark = useAction(async (id: string) => { await request('POST', t(`/notifications/${id}/read`), {}); load.reload(); onChange(); });
  return (
    <Page title="Notifications" sub={load.data ? `${load.data.unread} unread` : undefined} actions={<><Button disabled={!load.data?.unread} busy={mark.busy} onClick={() => mark.run('all')}>Mark all read</Button><Button onClick={load.reload}>Refresh</Button></>}>
      <ErrorBox error={mark.error} />
      <Async load={load}>{(d) => (
        <Section>{d.items.length === 0 && <p className="muted">Nothing yet. Scheduled runs notify here when their destination says so.</p>}
          <div className="list">{d.items.map((n) => (
            <button key={n.id} onClick={async () => { if (!n.read_at) await mark.run(n.id); if (n.run_id) go('runs', n.run_id); }}>
              <span className="row"><Signal status={n.severity === 'info' ? 'idle' : n.severity} label={n.severity} />{!n.read_at && <span className="badge">new</span>}<strong>{n.title}</strong></span>
              <span className="muted">{n.body}</span><span className="muted small">{n.query_name ? `${n.query_name} · ` : ''}{when(n.created_at)}</span>
            </button>))}</div></Section>)}</Async>
    </Page>
  );
}
