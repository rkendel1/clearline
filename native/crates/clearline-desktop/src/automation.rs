//! Automation channel for end-to-end tests and measurements (`--automation`).
//!
//! Reads one JSON command per line on stdin and writes one JSON response per line
//! on stdout. Commands go through the same view methods that buttons, inputs and
//! navigation use, so the tests exercise the real UI code paths against the real
//! backend; responses carry each view's snapshot (the values it is rendering).
//! Screenshots are taken from outside the process (see test/e2e/native.test.ts).

use crate::app::{Route, Shell};
use crate::perf;
use futures::{channel::mpsc, StreamExt};
use gpui::{App, AsyncWindowContext, Entity, Window};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::{BufRead, Write};
use std::rc::Rc;
use std::time::{Duration, Instant};

fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn start(shell: Entity<Shell>, window: &mut Window, cx: &mut App) {
    let (tx, mut rx) = mpsc::unbounded::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.unbounded_send(line).is_err() { break; }
        }
    });
    window.spawn(cx, async move |cx: &mut AsyncWindowContext| {
        emit(json!({ "event": "ready" }));
        while let Some(line) = rx.next().await {
            let cmd: Value = match serde_json::from_str(&line) { Ok(v) => v, Err(e) => { emit(json!({ "ok": false, "error": format!("bad json: {e}") })); continue; } };
            let id = cmd.get("id").cloned().unwrap_or(Value::Null);
            let res = run(&shell, &cmd, cx).await;
            let mut out = match res { Ok(v) => json!({ "ok": true, "result": v }), Err(e) => json!({ "ok": false, "error": e }) };
            out["id"] = id;
            emit(out);
        }
    }).detach();
}

fn s<'a>(cmd: &'a Value, k: &str) -> Result<&'a str, String> { cmd.get(k).and_then(Value::as_str).ok_or_else(|| format!("missing string field {k}")) }

async fn wait_idle(shell: &Entity<Shell>, cx: &mut AsyncWindowContext, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    // Let the command's effects schedule their work first.
    cx.background_executor().timer(Duration::from_millis(30)).await;
    loop {
        let busy = cx.update(|_, cx| shell.read(cx).busy(cx)).map_err(|e| e.to_string())?;
        if !busy { break; }
        if start.elapsed() > timeout { return Err("timed out waiting for the view to finish loading".into()); }
        cx.background_executor().timer(Duration::from_millis(40)).await;
    }
    // Two frames so the applied state has been rendered.
    for _ in 0..2 {
        let (tx, rx) = futures::channel::oneshot::channel::<()>();
        cx.update(|window, _| { window.on_next_frame(move |_, _| { let _ = tx.send(()); }); window.refresh(); }).map_err(|e| e.to_string())?;
        let _ = futures::future::select(rx, Box::pin(cx.background_executor().timer(Duration::from_millis(500)))).await;
    }
    Ok(())
}

fn snapshot(shell: &Entity<Shell>, cx: &mut AsyncWindowContext) -> Result<Value, String> {
    cx.update(|_, cx| shell.read(cx).snapshot(cx)).map_err(|e| e.to_string())
}

/// Sample frame-to-frame intervals for `frames` frames, calling `step(i)` before each frame.
async fn sample_frames(cx: &mut AsyncWindowContext, frames: usize, step: Rc<dyn Fn(usize, &mut Window, &mut App)>) -> Result<Vec<f64>, String> {
    let samples = Rc::new(RefCell::new(Vec::with_capacity(frames)));
    let (tx, rx) = futures::channel::oneshot::channel::<()>();
    let tx = Rc::new(RefCell::new(Some(tx)));
    fn tick(i: usize, frames: usize, last: Instant, samples: Rc<RefCell<Vec<f64>>>, step: Rc<dyn Fn(usize, &mut Window, &mut App)>, tx: Rc<RefCell<Option<futures::channel::oneshot::Sender<()>>>>, window: &mut Window, cx: &mut App) {
        if i > 0 { samples.borrow_mut().push(last.elapsed().as_secs_f64() * 1000.0); }
        if i >= frames { if let Some(t) = tx.borrow_mut().take() { let _ = t.send(()); } return; }
        step(i, window, cx);
        let now = Instant::now();
        window.on_next_frame(move |window, cx| tick(i + 1, frames, now, samples, step, tx, window, cx));
        window.refresh();
    }
    let s2 = samples.clone();
    cx.update(move |window, cx| tick(0, frames, Instant::now(), s2, step, tx, window, cx)).map_err(|e| e.to_string())?;
    let _ = rx.await;
    let v = samples.borrow().clone();
    Ok(v)
}

async fn run(shell: &Entity<Shell>, cmd: &Value, cx: &mut AsyncWindowContext) -> Result<Value, String> {
    let name = s(cmd, "cmd")?;
    let timeout = Duration::from_millis(cmd.get("timeout_ms").and_then(Value::as_u64).unwrap_or(60_000));
    macro_rules! with_window { ($f:expr) => { cx.update($f).map_err(|e| e.to_string())? } }
    match name {
        "state" => snapshot(shell, cx),
        "wait_idle" => { wait_idle(shell, cx, timeout).await?; snapshot(shell, cx) }
        "perf" => cx.update(|_, cx| perf::report(cx)).map_err(|e| e.to_string()),
        "sign_in" => {
            let token = s(cmd, "token")?.to_string();
            with_window!(|window, cx| {
                let signin = shell.read(cx).signin_view().clone();
                signin.update(cx, |v, cx| { v.token.update(cx, |t, cx| t.set_value(token, window, cx)); v.submit(window, cx); });
            });
            wait_idle(shell, cx, timeout).await?;
            snapshot(shell, cx)
        }
        "sign_out" => { with_window!(|window, cx| shell.update(cx, |s, cx| s.sign_out(window, cx))); wait_idle(shell, cx, timeout).await?; snapshot(shell, cx) }
        "theme" => {
            let dark = cmd.get("dark").and_then(Value::as_bool).unwrap_or(true);
            with_window!(|window, cx| shell.update(cx, |s, cx| if s.dark != dark { s.toggle_theme(window, cx) }));
            wait_idle(shell, cx, timeout).await?;
            snapshot(shell, cx)
        }
        "nav" => {
            let route = Route::parse(s(cmd, "view")?, cmd.get("arg").and_then(Value::as_str)).ok_or("unknown view")?;
            with_window!(|window, cx| shell.update(cx, |s, cx| s.navigate(route, window, cx)));
            wait_idle(shell, cx, timeout).await?;
            snapshot(shell, cx)
        }
        c if c.starts_with("query.") => {
            let q = cx.update(|_, cx| shell.read(cx).query_view().cloned()).map_err(|e| e.to_string())?.ok_or("open the query workspace first")?;
            let mut copied = None;
            match c {
                "query.ask" => { let t = s(cmd, "text")?.to_string(); with_window!(|window, cx| q.update(cx, |q, cx| { q.set_question(&t, window, cx); q.generate(window, cx); })) }
                "query.set_question" => { let t = s(cmd, "text")?.to_string(); with_window!(|window, cx| q.update(cx, |q, cx| q.set_question(&t, window, cx))) }
                "query.set_sql" => { let t = s(cmd, "text")?.to_string(); with_window!(|window, cx| q.update(cx, |q, cx| { q.set_sql(&t, window, cx); cx.notify(); })) }
                "query.validate" => with_window!(|window, cx| q.update(cx, |q, cx| q.validate(window, cx))),
                "query.run" => {
                    let mode: &'static str = if cmd.get("mode").and_then(Value::as_str) == Some("preview") { "preview" } else { "run" };
                    with_window!(|window, cx| q.update(cx, |q, cx| q.execute(mode, window, cx)));
                    if let Some(ms) = cmd.get("cancel_after_ms").and_then(Value::as_u64) {
                        cx.background_executor().timer(Duration::from_millis(ms)).await;
                        with_window!(|_, cx| q.update(cx, |q, cx| q.cancel(cx)));
                    }
                }
                "query.cancel" => with_window!(|_, cx| q.update(cx, |q, cx| q.cancel(cx))),
                "query.export" => with_window!(|_, cx| q.update(cx, |q, cx| q.export(cx))),
                "query.copy_row" => { copied = with_window!(|_, cx| q.update(cx, |q, cx| q.copy_row(cx))); }
                "query.save" => { let n = s(cmd, "name")?.to_string(); with_window!(|window, cx| q.update(cx, |q, cx| { q.save_name.update(cx, |i, cx| i.set_value(n.clone(), window, cx)); q.save_as(cx); })) }
                _ => return Err(format!("unknown command {c}")),
            }
            wait_idle(shell, cx, timeout).await?;
            let mut snap = snapshot(shell, cx)?;
            if let Some(t) = copied { snap["copied"] = json!(t); }
            Ok(snap)
        }
        c if ["fields.", "records.", "lineage.", "history.", "library.", "schedule.", "analysis.", "run.", "runs.", "notifications.", "destinations."].iter().any(|p| c.starts_with(p)) => {
            crate::views::automation_command(shell, c, cmd, cx).await?;
            wait_idle(shell, cx, timeout).await?;
            snapshot(shell, cx)
        }
        "bench.scroll" => {
            // Scroll the query result grid through all rows, one step per frame.
            let frames = cmd.get("frames").and_then(Value::as_u64).unwrap_or(120) as usize;
            let q = cx.update(|_, cx| shell.read(cx).query_view().cloned()).map_err(|e| e.to_string())?.ok_or("open the query workspace first")?;
            let grid = cx.update(|_, cx| q.read(cx).grid.clone()).map_err(|e| e.to_string())?;
            let rows = cx.update(|_, cx| grid.read(cx).delegate().rows.len()).map_err(|e| e.to_string())?;
            if rows == 0 { return Err("run a query with rows first".into()); }
            let step: Rc<dyn Fn(usize, &mut Window, &mut App)> = Rc::new(move |i, _window, cx| {
                let target = (i * rows / frames.max(1)).min(rows - 1);
                grid.update(cx, |t, cx| t.scroll_to_row(target, cx));
            });
            let samples = sample_frames(cx, frames, step).await?;
            Ok(json!({ "rows": rows, "frames": perf::summary(&samples) }))
        }
        "bench.type" => {
            // Type into the SQL editor one character per frame (optionally while a query runs) and time the frames.
            let frames = cmd.get("frames").and_then(Value::as_u64).unwrap_or(120) as usize;
            let q = cx.update(|_, cx| shell.read(cx).query_view().cloned()).map_err(|e| e.to_string())?.ok_or("open the query workspace first")?;
            let while_running = cmd.get("while_running").and_then(Value::as_bool).unwrap_or(false);
            if while_running { with_window!(|window, cx| q.update(cx, |q, cx| q.execute("run", window, cx))); }
            let q2 = q.clone();
            let step: Rc<dyn Fn(usize, &mut Window, &mut App)> = Rc::new(move |i, window, cx| {
                q2.update(cx, |q, cx| q.sql.update(cx, |s, cx| { let mut v = s.value().to_string(); v.push(if i % 20 == 19 { '\n' } else { ' ' }); s.set_value(v, window, cx); }));
            });
            let running_at_start = cx.update(|_, cx| q.read(cx).phase == crate::views::query::Phase::Running).map_err(|e| e.to_string())?;
            let samples = sample_frames(cx, frames, step).await?;
            let running_at_end = cx.update(|_, cx| q.read(cx).phase == crate::views::query::Phase::Running).map_err(|e| e.to_string())?;
            if while_running { with_window!(|_, cx| q.update(cx, |q, cx| q.cancel(cx))); wait_idle(shell, cx, timeout).await?; }
            Ok(json!({ "frames": perf::summary(&samples), "query_running_at_start": running_at_start, "query_running_at_end": running_at_end }))
        }
        "quit" => { with_window!(|_, cx| cx.quit()); Ok(json!({ "quitting": true })) }
        other => Err(format!("unknown command {other}")),
    }
}
