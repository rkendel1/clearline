// Drives the native GPUI client (native/target/<profile>/clearline --automation) for the
// end-to-end tests: starts an X server (Xvfb + a window manager) when there is no display,
// launches the real binary against the real API, sends automation commands (the same view
// methods the UI's buttons and inputs call) and takes screenshots of the real window.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './harness.js';

export const NATIVE_BIN = process.env.NATIVE_BIN ?? [path.join(ROOT, 'native/target/release/clearline'), path.join(ROOT, 'native/target/debug/clearline')].find((p) => existsSync(p));
export const SHOTS = path.join(ROOT, 'test-results/native');

const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

export class Display {
  private procs: ChildProcess[] = [];
  display = process.env.DISPLAY ?? '';
  async start() {
    if (this.display) return;
    if (!have('Xvfb')) throw new Error('No DISPLAY and Xvfb is not installed (apt-get install xvfb openbox mesa-vulkan-drivers)');
    this.display = ':97';
    this.procs.push(spawn('Xvfb', [this.display, '-screen', '0', '1440x940x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 800));
    if (have('openbox')) this.procs.push(spawn('openbox', [], { stdio: 'ignore', env: { ...process.env, DISPLAY: this.display } }));
    await new Promise((r) => setTimeout(r, 500));
  }
  stop() { for (const p of this.procs.reverse()) p.kill('SIGTERM'); }
}

export class NativeApp {
  private proc!: ChildProcess;
  private waiting: ((v: any) => void)[] = [];
  private seq = 0;
  stderr = '';
  constructor(private display: Display, private url: string, private extraArgs: string[] = []) {}

  async start(): Promise<any> {
    if (!NATIVE_BIN) throw new Error('Build the native client first: npm run native:build');
    const started = Date.now();
    this.proc = spawn(NATIVE_BIN, ['--automation', '--url', this.url, ...this.extraArgs], {
      env: { ...process.env, DISPLAY: this.display.display, CLEARLINE_TOKEN: '' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr!.on('data', (d) => { this.stderr += d.toString(); if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000); });
    createInterface({ input: this.proc.stdout! }).on('line', (line) => {
      let v: any;
      try { v = JSON.parse(line); } catch { return; }
      this.waiting.shift()?.(v);
    });
    const ready = await this.next(60_000);
    return { ...ready, spawn_to_ready_ms: Date.now() - started };
  }

  private next(timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`native client did not answer within ${timeout} ms\n${this.stderr.slice(-2000)}`)), timeout);
      this.waiting.push((v) => { clearTimeout(t); resolve(v); });
    });
  }

  /** Send one automation command; resolves with its result (throws on an automation error). */
  async cmd(c: Record<string, unknown>, timeout = 90_000): Promise<any> {
    const id = ++this.seq;
    const p = this.next(timeout);
    this.proc.stdin!.write(JSON.stringify({ ...c, id }) + '\n');
    const r = await p;
    if (!r.ok) throw new Error(`automation ${String(c.cmd)} failed: ${r.error}`);
    return r.result;
  }

  /** Screenshot of the whole (virtual) screen, i.e. the real rendered window. Returns the path, or null without ImageMagick. */
  screenshot(name: string): string | null {
    if (!have('import')) return null;
    mkdirSync(SHOTS, { recursive: true });
    const out = path.join(SHOTS, `${name}.png`);
    spawnSync('import', ['-window', 'root', out], { env: { ...process.env, DISPLAY: this.display.display } });
    return out;
  }

  async stop() {
    try { await this.cmd({ cmd: 'quit' }, 5000); } catch { /* exiting */ }
    await new Promise((r) => setTimeout(r, 300));
    this.proc.kill('SIGTERM');
  }
}
