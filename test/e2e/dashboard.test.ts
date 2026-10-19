// End-to-end: real HTTP server + worker + built dashboard in Chromium.
// Scenario J (dashboard half): the numbers a person sees on the dashboard equal
// ground truth from the generator and independent SQL over persisted data.
// Requires `npm --prefix dashboard run build` first (CI does this).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { setup, teardown, client, DEV_TOKENS, evidence, sql, ROOT, type Ctx } from '../helpers/harness.js';
import { loadReferenceDataset, type Truth } from '../../synthetic/reference-dataset.js';

let ctx: Ctx;
let truth: Truth;
let browser: Browser;
let base: string;

before(async () => {
  assert.ok(existsSync(path.join(ROOT, 'dashboard/dist/index.html')), 'build the dashboard first: npm --prefix dashboard run build');
  ctx = await setup();
  truth = await loadReferenceDataset(client(ctx, DEV_TOKENS.northwind.operator), client(ctx, DEV_TOKENS.bluefin.operator));
  await ctx.worker.drain();
  base = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => { await browser?.close(); await teardown(ctx); });

async function signIn(token: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text()); });
  await page.goto(base + '/');
  await page.fill('#token', token);
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=business-metrics]');
  await page.waitForLoadState('networkidle');
  assert.equal(await page.evaluate(() => document.fonts.check('16px "Public Sans"')), true, 'self-hosted font loaded under CSP');
  assert.deepEqual(errors, [], 'no script errors or CSP violations');
  return page;
}

const shown = (page: Page, sel: string) => page.$$eval(sel, (els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.metric ?? (e as HTMLElement).dataset.total, (e as HTMLElement).dataset.value])));
const text = (page: Page, sel: string) => page.$$eval(sel, (els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.metric, e.querySelector('.metric-value')?.textContent ?? ''])));

test('Scenario J (dashboard): rendered metrics equal ground truth and independent SQL, for both tenants', async () => {
  const lines: string[] = [];
  for (const tenant of ['northwind', 'bluefin'] as const) {
    const page = await signIn(DEV_TOKENS[tenant].reporter);
    assert.match(await page.textContent('h1') ?? '', new RegExp(tenant));
    const values = await shown(page, '[data-metric]');
    const visible = await text(page, '[data-metric]');
    for (const [id, want] of Object.entries(truth[tenant])) {
      assert.equal(values[id], want, `${tenant}.${id} data-value`);
      assert.equal(visible[id].replace(/[$,]/g, ''), want, `${tenant}.${id} as displayed ("${visible[id]}")`);
    }
    lines.push(`${tenant}: ${Object.keys(truth[tenant]).length} metric tiles display exactly the ground-truth values (e.g. ${Object.entries(visible).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(', ')}).`);

    const totals = await shown(page, '[data-total]');
    const s = (await sql(`SELECT count(*)::int batches, count(*) FILTER (WHERE status IN ('completed','completed_with_exceptions'))::int succeeded,
        count(*) FILTER (WHERE trust_status = 'trusted')::int trusted, count(*) FILTER (WHERE trust_status = 'untrusted')::int untrusted FROM core.batches WHERE tenant_id = $1`, [tenant]))[0];
    for (const k of Object.keys(s)) assert.equal(Number(totals[k]), s[k], `${tenant} ${k} tile vs SQL`);
    lines.push(`${tenant}: ran-vs-trusted tiles equal SQL over core.batches (${s.batches} batches, ${s.succeeded} ran, ${s.trusted} trusted, ${s.untrusted} not trusted).`);
    await page.close();
  }

  // The untrusted batch is visibly distinguished from a successful run, with its reason.
  const page = await signIn(DEV_TOKENS.northwind.operator);
  assert.match(await page.textContent('[data-testid=verdict]') ?? '', /1 batch is not trusted/);
  const untrustedRow = page.locator('tr[data-batch]', { hasText: 'Not trusted' });
  assert.equal(await untrustedRow.count(), 1);
  assert.match(await untrustedRow.textContent() ?? '', /Ran/);
  await untrustedRow.locator('button.link').click();
  await page.waitForSelector('[data-check="source_control_count"]');
  assert.match(await page.textContent('[data-check="source_control_count"]') ?? '', /Sender declared 61 rows but 60 arrived/);
  lines.push('Untrusted batch appears as "Ran" + "Not trusted"; its detail page shows the failed source_control_count check and explanation.');

  // A reporter cannot see the lineage view; a cross-tenant token sees only its own tenant.
  const rep = await signIn(DEV_TOKENS.bluefin.reporter);
  assert.equal(await rep.locator('nav a', { hasText: 'Lineage' }).count(), 0);
  assert.match(await rep.textContent('h1') ?? '', /bluefin/);
  assert.equal(await rep.locator('[data-metric="claims_total"]').count(), 0, 'no northwind metrics leak into the bluefin view');
  lines.push('bluefin reporter: no lineage navigation, only bluefin metrics rendered.');
  await page.close(); await rep.close();

  evidence('Scenario J — Reporting correctness (dashboard, Chromium)', lines);
});
