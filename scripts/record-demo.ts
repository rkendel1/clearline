// Records the demonstration video (docs/demo/clearline-demo.mp4) from a fresh
// database: normal operation plus four failure scenarios, with captions.
// Everything shown is live: real server, real worker, real database.
//   npm run dashboard:build && npm run demo:record
// Needs Chromium (Playwright) and, for the MP4, ffmpeg on PATH (otherwise the WebM is kept).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB = 'clearline_recording';
process.env.DATABASE_URL = `${process.env.PGHOST_URL ?? 'postgres://clearline:clearline@localhost:5432'}/${DB}`;
process.env.NODE_ENV = 'test'; process.env.LOG_LEVEL = 'error'; process.env.DASHBOARD_DIR = path.join(ROOT, 'dashboard/dist');
const { chromium } = await import('playwright');
const { buildServer } = await import('../src/api/server.js');
const { migrate } = await import('../src/platform/migrate.js');
const { closePool } = await import('../src/platform/db.js');
const { Worker } = await import('../src/ingestion/worker.js');
const { seed, DEV_TOKENS } = await import('./seed.js');
const { loadReferenceDataset } = await import('../synthetic/reference-dataset.js');

execFileSync(path.join(ROOT, 'scripts/reset-db.sh'), [DB], { stdio: 'inherit' });
await migrate(); await seed();
const app = await buildServer();
const base = await app.listen({ port: 0, host: '127.0.0.1' });
const submitter = (token: string) => {
  const call = async (method: string, url: string, body: unknown, headers: Record<string, string>) => {
    const r = await fetch(base + url, { method, body: body as never, headers: { authorization: `Bearer ${token}`, ...headers } });
    return { status: r.status, body: await r.json() };
  };
  return {
    csv: (t: string, s: string, csv: Buffer, o: { reportedAt?: string; control?: unknown } = {}) => call('POST', `/api/v1/tenants/${t}/batches/csv?source=${s}${o.reportedAt ? `&source_reported_at=${encodeURIComponent(o.reportedAt)}` : ''}`, new Uint8Array(csv), { 'content-type': 'text/csv', ...(o.control ? { 'x-clearline-control': JSON.stringify(o.control) } : {}) }),
    json: (t: string, s: string, records: unknown[], o: { reportedAt?: string; control?: unknown } = {}) => call('POST', `/api/v1/tenants/${t}/batches`, JSON.stringify({ source: s, records, source_reported_at: o.reportedAt, control: o.control }), { 'content-type': 'application/json' }),
  };
};
await loadReferenceDataset(submitter(DEV_TOKENS.northwind.operator), submitter(DEV_TOKENS.bluefin.operator));
await new Worker().drain();
const v2 = JSON.parse(readFileSync(path.join(ROOT, 'contracts/northwind/v2.json'), 'utf8'));
await fetch(`${base}/api/v1/tenants/northwind/contracts`, { method: 'POST', body: JSON.stringify(v2), headers: { authorization: `Bearer ${DEV_TOKENS.northwind.admin}`, 'content-type': 'application/json' } });

const outDir = path.join(ROOT, 'docs/demo');
const tmp = path.join(outDir, '.raw');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, recordVideo: { dir: tmp, size: { width: 1280, height: 760 } } });
const page = await ctx.newPage();
page.on('dialog', (d) => void d.accept(d.message().includes('target version') ? '2.0.0' : 'demo'));
const wait = (ms: number) => page.waitForTimeout(ms);

async function caption(title: string, body: string, ms = 4200) {
  await page.evaluate(([t, b]) => {
    let el = document.getElementById('demo-caption');
    if (!el) {
      el = document.createElement('div'); el.id = 'demo-caption';
      Object.assign(el.style, { position: 'fixed', left: '50%', bottom: '18px', transform: 'translateX(-50%)', maxWidth: '900px', width: 'calc(100% - 80px)', background: 'rgba(23,34,45,0.94)', color: '#f3f5f2', padding: '14px 20px', borderRadius: '6px', font: '15px/1.45 "Public Sans", system-ui, sans-serif', zIndex: '9999', boxShadow: '0 6px 24px rgba(0,0,0,.25)' });
      document.body.appendChild(el);
    }
    el.innerHTML = '';
    const h = document.createElement('strong'); h.textContent = t; h.style.display = 'block'; h.style.fontSize = '16px'; h.style.marginBottom = '3px';
    const p = document.createElement('span'); p.textContent = b;
    el.append(h, p);
  }, [title, body]);
  await wait(ms);
}
async function signIn(token: string, ready = '[data-testid=business-metrics]') {
  await page.evaluate(() => { try { sessionStorage.clear(); } catch { /* first load */ } }).catch(() => {});
  await page.goto(base + '/#/overview');
  await page.reload();
  await page.fill('#token', token);
  await wait(500);
  await page.click('button[type=submit]');
  await page.waitForSelector(ready);
}
const scrollTo = async (sel: string) => { await page.locator(sel).first().scrollIntoViewIfNeeded(); await wait(400); };

// 1. Normal operation
await page.goto(base + '/');
await caption('Clearline', 'A contract-driven healthcare data platform, shown here with entirely synthetic data. Two tenants with different canonical models run through the same code.', 4500);
await signIn(DEV_TOKENS.northwind.operator);
await caption('Normal operation', 'Northwind’s plans, members, claims and pharmacy fills have been ingested. The first question the dashboard answers: can this data be trusted right now?');
await scrollTo('#business');
await caption('Trusted metrics', 'Every figure counts only batches that reconciled. Where something is held back, the tile says how much and what the figure would be if it were included.', 5000);
// 2. Failure: reconciliation
await scrollTo('#recent');
await caption('Failure 1: a batch ran but is not trusted', 'Every batch shows two separate signals. This claims batch processed successfully, but it is not trusted.', 4500);
await page.locator('tr[data-batch]', { hasText: 'Not trusted' }).locator('button.link').click();
await page.waitForSelector('[data-check="source_control_count"]');
await scrollTo('#recon');
await caption('Reconciliation explains the difference', 'The sender declared 61 rows; 60 arrived. The batch is held out of trusted outputs until a corrected file is received.', 5000);
// 3. Failure: bad data
await page.goto(base + '/#/exceptions'); await page.waitForSelector('#quarantine'); await scrollTo('#quarantine');
await caption('Failure 2: bad data is quarantined', 'An impossible date, paid more than billed, a denied claim with a payment: each row is held with its rule, field and source row number, and none of it reaches trusted metrics.', 5200);
// 4. Lineage
await page.goto(base + '/#/lineage'); await page.selectOption('select', 'claim'); await page.fill('input', 'C000000104'); await page.click('text=Trace record');
await page.waitForSelector('.timeline'); await wait(600);
await caption('Lineage and corrections', 'Claim C000000104 was denied, then re-adjudicated as paid. Both versions are kept, each traced to its source row, batch, contract version, reconciliation and the metrics it counts toward.', 5500);
await page.mouse.wheel(0, 520); await wait(1500);
// 5. Failure: privacy
await signIn(DEV_TOKENS.northwind.reporter);
await page.goto(base + '/#/extracts'); await page.waitForSelector('text=Download CSV');
await page.check('text=Include sensitive fields');
await page.locator('button', { hasText: 'Download CSV' }).first().click();
await page.waitForSelector('.note[role=status]');
await caption('Failure 3: an unauthorized sensitive export is denied', 'A reporting user asks for unredacted fields. The backend refuses and records the attempt in the audit trail. Default extracts redact PII and PHI.', 5200);
// 6. Failure: breaking contract change
await signIn(DEV_TOKENS.northwind.approver, '[data-migration]');
await caption('Failure 4: a breaking contract change', 'Version 2.0.0 adds a required field, renames a status and removes a column. It cannot apply itself: an approver, a role with no data access that tenant admins cannot create, reviews every change, its DDL, the rows affected and the rollback.', 5500);
await page.mouse.wheel(0, 300); await wait(1200);
await page.locator('button', { hasText: 'Approve and apply' }).click();
await page.waitForSelector('.note-good');
await page.mouse.wheel(0, -1000); await wait(400);
await caption('Approved by the approver', 'Applied in one transaction. Existing records were not edited: they got new versions, and the old ones keep the meaning they had under 1.0.0.', 5200);
await signIn(DEV_TOKENS.northwind.operator);
await caption('Every number is checked', 'The automated scenarios (A–J) check these figures against independent SQL and the generator’s own answers. Duplicate delivery, crash recovery and cross-tenant access are covered there too.', 5200);

await ctx.close(); await browser.close();
const raw = readdirSync(tmp).find((f) => f.endsWith('.webm'))!;
const webm = path.join(outDir, 'clearline-demo.webm');
renameSync(path.join(tmp, raw), webm);
rmSync(tmp, { recursive: true, force: true });
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-movflags', '+faststart', path.join(outDir, 'clearline-demo.mp4')]);
if (ff.status === 0) { rmSync(webm); console.log('wrote docs/demo/clearline-demo.mp4'); } else console.log('ffmpeg unavailable; kept docs/demo/clearline-demo.webm');
await app.close(); await closePool();
