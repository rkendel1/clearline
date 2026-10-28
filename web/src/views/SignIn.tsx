import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, request, session, type Me } from '../lib/api';
import { Button, ErrorBox, Field, Note, Section } from '../ui';

// Seeded demo tokens exist only outside production (README). Choosing one fills the field; it is never stored.
const DEMO = ['cl_dev_northwind_admin', 'cl_dev_northwind_operator', 'cl_dev_northwind_steward', 'cl_dev_northwind_approver', 'cl_dev_northwind_reporter', 'cl_dev_bluefin_admin', 'cl_dev_platform_admin'];

export function SignIn({ onSignedIn, expired }: { onSignedIn: (m: Me) => void; expired: boolean }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  // The seeded dev tokens exist only on the local demo stack; the server says whether to offer them (default: hide).
  const [demo, setDemo] = useState(false);
  useEffect(() => { request<{ demo_tokens?: boolean }>('GET', '/api/public/assistant/status').then((s) => setDemo(s.demo_tokens === true), () => setDemo(false)); }, []);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { onSignedIn(await session.signIn(token)); }
    catch (err) { setError(err instanceof ApiError ? err : new ApiError(0, 'client_error', String(err))); }
    finally { setBusy(false); }
  };
  return (
    <div className="signin">
      <form onSubmit={submit}>
        <Section title="Clearline" actions={<a href="#/">← About Clearline</a>}>
          <p className="muted">Sign in with an API token. It is held in this tab's memory only; closing or reloading the tab signs you out.</p>
          {expired && <Note tone="warn">Your token was rejected or has been revoked. Sign in again.</Note>}
          <Field label="API token"><input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} autoFocus /></Field>
          <ErrorBox error={error} />
          <Button type="submit" primary busy={busy} disabled={!token.trim()}>Sign in</Button>
          {demo && <details open><summary>Demo tokens (synthetic data, local only)</summary>
            <div className="demo-tokens">{DEMO.map((d) => <button type="button" key={d} className="btn small" onClick={() => setToken(d)}>{d.replace('cl_dev_', '')}</button>)}</div>
          </details>}
        </Section>
      </form>
    </div>
  );
}
