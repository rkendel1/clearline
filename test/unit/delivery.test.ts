// Delivery primitives: SSRF address checks, DNS pinning, webhook signing, SMTP message safety.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { blockedReason, resolveTarget, DestinationError } from '../../src/delivery/ssrf.js';
import { postWebhook, sign } from '../../src/delivery/webhook.js';
import { buildMessage, dataPayload, sendSmtp, validAddress } from '../../src/delivery/smtp.js';
import { wants } from '../../src/delivery/deliver.js';

test('SSRF: private, loopback, link-local, reserved and embedded forms are refused; public addresses pass', () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '198.18.0.1', '192.0.2.10', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.8', '64:ff9b::a00:1', '2002:0a00:0001::1', '2001:db8::1']) {
    assert.ok(blockedReason(a), `${a} must be blocked`);
  }
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(blockedReason(a), null, a);
});

test('SSRF: every resolved address is checked (a rebinding-style answer mixing public and private is refused)', async () => {
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }];
  await assert.rejects(resolveTarget('https://hooks.example.org/x', { allowPrivate: false, resolver }), (e: DestinationError) => e.code === 'private_address');
  const ok = await resolveTarget('https://hooks.example.org/x', { allowPrivate: false, resolver: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(ok.address, '93.184.216.34');
  for (const [u, code] of [['http://hooks.example.org/x', 'https_required'], ['https://a:b@hooks.example.org/', 'credentials_in_url'], ['https://hooks.example.org:25/', 'port_not_allowed'], ['not a url', 'invalid_url']]) {
    await assert.rejects(resolveTarget(u, { allowPrivate: false, resolver }), (e: DestinationError) => e.code === code, u);
  }
});

test('webhook: the connection is pinned to the checked address (no second DNS lookup), redirects are not followed, the signature verifies', async () => {
  const got: { host?: string; sig?: string; body: string }[] = [];
  let status = 200;
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push({ host: req.headers.host, sig: String(req.headers['clearline-signature']), body: b }); res.writeHead(status, status === 302 ? { location: 'http://169.254.169.254/' } : {}).end(); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  // "rebind.invalid" does not exist in DNS; only the injected resolver knows it. Success proves the request used the checked address.
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const r = await postWebhook({ url: `http://rebind.invalid:${port}/h`, body: '{"a":1}', deliveryId: 'd1', event: 'test', secret: 'k', timeoutMs: 2000, allowPrivate: true, resolver });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(got[0].host, `rebind.invalid:${port}`);
  const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(got[0].sig!)!;
  assert.equal(createHmac('sha256', 'k').update(`${t}.{"a":1}`).digest('hex'), v1);
  assert.equal(sign('k', '{"a":1}', Number(t)), got[0].sig);
  status = 302;
  const redirected = await postWebhook({ url: `http://rebind.invalid:${port}/h`, body: '{}', deliveryId: 'd2', event: 'test', secret: 'k', timeoutMs: 2000, allowPrivate: true, resolver });
  assert.deepEqual([redirected.ok, redirected.transient, redirected.code], [false, false, 'redirect_not_followed']);
  const blocked = await postWebhook({ url: `https://rebind.invalid/h`, body: '{}', deliveryId: 'd3', event: 'test', secret: 'k', timeoutMs: 2000, allowPrivate: false, resolver });
  assert.deepEqual([blocked.ok, blocked.code], [false, 'private_address']);
  server.close();
});

test('SMTP: header injection is refused, dot-stuffing is applied, addresses are validated, TLS is enforced', async () => {
  const m = { from: 'a@example.org', to: ['b@example.org'], subject: 'Hello', text: 'line\n.starts with a dot\n', messageId: 'id1@clearline' };
  assert.throws(() => buildMessage({ ...m, subject: 'x\r\nBcc: victim@example.org' }), /single line/);
  assert.throws(() => buildMessage({ ...m, headers: { 'X-A': 'v\nInjected: 1' } }), /single line/);
  assert.match(buildMessage({ ...m, subject: 'Prüfung' }), /Subject: =\?UTF-8\?B\?/);
  assert.match(dataPayload('a\r\n.b\r\n..c'), /\r\n\.\.b\r\n\.\.\.c\r\n\.\r\n$/);
  for (const bad of ['no-at', 'a@b', 'a@@example.org', 'a b@example.org', '<a@example.org>']) assert.equal(validAddress(bad), false, bad);
  assert.equal(validAddress('first.last+tag@sub.example.org'), true);
  // A relay that does not offer STARTTLS is refused unless plain text was configured explicitly (and never in production).
  const server = net.createServer((s) => { s.write('220 x\r\n'); s.on('data', (d) => { if (/^EHLO/i.test(String(d))) s.write('250 x\r\n'); else if (/^QUIT/i.test(String(d))) s.end(); }); s.on('error', () => {}); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const noTls = await sendSmtp(`smtp://127.0.0.1:${port}`, m, { timeoutMs: 2000, production: false });
  assert.deepEqual([noTls.ok, noTls.transient, noTls.code], [false, false, 'starttls_unavailable']);
  const prod = await sendSmtp(`smtp://127.0.0.1:${port}?tls=none`, m, { timeoutMs: 2000, production: true });
  assert.deepEqual([prod.ok, prod.code], [false, 'insecure_smtp']);
  const badAddr = await sendSmtp(`smtp://127.0.0.1:${port}?tls=none`, { ...m, to: ['nope'] }, { timeoutMs: 2000, production: false });
  assert.equal(badAddr.code, 'invalid_address');
  server.close();
});

test('delivery policy: success-only, failure-only, anomaly-only and always', () => {
  const ok = { querySucceeded: true, failed: false, anomaly: false };
  const anomaly = { querySucceeded: true, failed: false, anomaly: true };
  const failed = { querySucceeded: false, failed: true, anomaly: false };
  assert.deepEqual(['always', 'success', 'failure', 'anomaly'].map((p) => [wants(p, ok), wants(p, anomaly), wants(p, failed)]),
    [[true, true, true], [true, true, false], [false, false, true], [false, true, false]]);
});
