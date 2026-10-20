import { useEffect } from 'react';
import { request, enc } from '../lib/api';
import { useRoute } from '../lib/router';
import { useLoad } from '../lib/useLoad';
import { Async, Page, Section } from '../ui';

// Citations resolve here: an approved document, shown as text. The server serves only allow-listed paths.
export function Source() {
  const path = useRoute().query.get('path') ?? '';
  const load = useLoad((s) => request<{ path: string; access: string; text: string }>('GET', `/api/public/source?path=${enc(path)}`, undefined, { signal: s }), [path]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [path]);
  return (
    <div className="landing"><Page title={path.split('/').pop() ?? 'Source'} sub={<><button className="linklike" onClick={() => window.history.back()}>← Back</button> · <span className="mono">{path}</span></>} >
      <Async load={load}>{(d) => <Section><pre className="code doc">{d.text}</pre></Section>}</Async>
    </Page></div>
  );
}
