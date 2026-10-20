//! Repeatable UI measurements (docs/benchmark.md, "Native client"):
//!   startup_ms         process start -> first frame drawn
//!   marks              named intervals, e.g. "result rows applied -> frame drawn"
//!   frame samples      frame-to-frame intervals while a scripted interaction runs
//! Times come from `on_next_frame`, i.e. after GPUI has drawn the frame.

use gpui::{App, Global, Window};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Instant;

pub static START: OnceLock<Instant> = OnceLock::new();
pub fn mark_process_start() { START.get_or_init(Instant::now); }
pub fn since_start_ms() -> f64 { START.get().map(|s| s.elapsed().as_secs_f64() * 1000.0).unwrap_or(0.0) }

#[derive(Default)]
pub struct Perf { scheduled: bool }

#[derive(Default)]
pub struct PerfLog {
    pub startup_ms: Option<f64>,
    pub marks: Vec<(String, f64)>,
}
impl Global for PerfLog {}

impl Perf {
    /// Called from the shell's render: records when the very first frame has been drawn.
    pub fn first_frame(&mut self, window: &mut Window) {
        if self.scheduled { return; }
        self.scheduled = true;
        window.on_next_frame(|_, cx| { let ms = since_start_ms(); cx.default_global::<PerfLog>().startup_ms.get_or_insert(ms); });
    }
}

/// Record `label` as the time from `since` until the next frame has been drawn.
pub fn mark_after_next_frame(window: &Window, label: impl Into<String>, since: Instant) {
    let label = label.into();
    window.on_next_frame(move |_, cx| { let ms = since.elapsed().as_secs_f64() * 1000.0; cx.default_global::<PerfLog>().marks.push((label, ms)); });
}

pub fn summary(samples: &[f64]) -> Value {
    if samples.is_empty() { return json!(null); }
    let mut s = samples.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| s[((s.len() as f64 - 1.0) * p).round() as usize];
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    json!({ "n": s.len(), "mean_ms": round(mean), "p50_ms": round(q(0.5)), "p95_ms": round(q(0.95)), "max_ms": round(*s.last().unwrap()), "fps_mean": round(1000.0 / mean) })
}

pub fn round(x: f64) -> f64 { (x * 100.0).round() / 100.0 }

pub fn report(cx: &App) -> Value {
    let log = cx.try_global::<PerfLog>();
    json!({
        "startup_ms": log.and_then(|l| l.startup_ms).map(round),
        "marks": log.map(|l| l.marks.iter().map(|(k, v)| json!({ "label": k, "ms": round(*v) })).collect::<Vec<_>>()).unwrap_or_default(),
    })
}
