//! Time-series chart for analysis results: observed values, an expected band, optional
//! forecast values with their interval, and anomaly markers. Drawn with GPUI paths on a
//! canvas; the numbers are exactly those the server computed (nothing is re-derived).

use crate::ui::pal;
use gpui::{canvas, div, point, prelude::*, px, quad, size, App, BorderStyle, Bounds, Hsla, PathBuilder, Pixels, SharedString};
use gpui_component::{h_flex, v_flex};

#[derive(Clone, Debug, Default)]
pub struct Point { pub label: String, pub observed: Option<f64>, pub lower: Option<f64>, pub upper: Option<f64>, pub expected: Option<f64>, pub forecast: Option<f64>, pub marker: Option<&'static str> }

#[derive(Clone, Debug, Default)]
pub struct Series { pub title: String, pub points: Vec<Point> }

fn extent(s: &Series) -> (f64, f64) {
    let mut lo = f64::INFINITY; let mut hi = f64::NEG_INFINITY;
    for p in &s.points { for v in [p.observed, p.lower, p.upper, p.expected, p.forecast].into_iter().flatten() { lo = lo.min(v); hi = hi.max(v); } }
    if !lo.is_finite() { return (0.0, 1.0); }
    if hi - lo < 1e-9 { return (lo - 1.0, hi + 1.0); }
    let pad = (hi - lo) * 0.06;
    (lo - pad, hi + pad)
}

pub fn chart(id: &str, s: &Series, height: f32, cx: &App) -> gpui::Stateful<gpui::Div> {
    let p = pal(cx);
    let series = s.clone();
    let (lo, hi) = extent(s);
    let (ink, band, accent, warn, bad, rule): (Hsla, Hsla, Hsla, Hsla, Hsla, Hsla) = (p.ink2, p.accent.opacity(0.14), p.accent, p.warn_ink, p.bad_ink, p.rule);
    let n = series.points.len().max(2);
    let first = series.points.first().map(|x| x.label.clone()).unwrap_or_default();
    let last = series.points.last().map(|x| x.label.clone()).unwrap_or_default();
    let plot = canvas(|_, _, _| (), move |bounds: Bounds<Pixels>, _, window, _| {
        let (w, h) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        let xp = |i: usize| bounds.origin.x + px(w * i as f32 / (n - 1) as f32);
        let yp = |v: f64| bounds.origin.y + px(h * (1.0 - ((v - lo) / (hi - lo)) as f32));
        // Baseline rule.
        let mut b = PathBuilder::stroke(px(1.));
        b.move_to(point(bounds.origin.x, bounds.origin.y + px(h)));
        b.line_to(point(bounds.origin.x + px(w), bounds.origin.y + px(h)));
        if let Ok(path) = b.build() { window.paint_path(path, rule); }
        // Expected / interval band: upper edge forward, lower edge back.
        let band_pts: Vec<(usize, f64, f64)> = series.points.iter().enumerate().filter_map(|(i, q)| Some((i, q.lower?, q.upper?))).collect();
        for run in band_pts.chunk_by(|a, b| b.0 == a.0 + 1) {
            if run.len() < 2 { continue; }
            let mut f = PathBuilder::fill();
            f.move_to(point(xp(run[0].0), yp(run[0].2)));
            for q in &run[1..] { f.line_to(point(xp(q.0), yp(q.2))); }
            for q in run.iter().rev() { f.line_to(point(xp(q.0), yp(q.1))); }
            f.close();
            if let Ok(path) = f.build() { window.paint_path(path, band); }
        }
        let line = |pick: &dyn Fn(&Point) -> Option<f64>, color: Hsla, width: f32, window: &mut gpui::Window| {
            let pts: Vec<(usize, f64)> = series.points.iter().enumerate().filter_map(|(i, q)| pick(q).map(|v| (i, v))).collect();
            for run in pts.chunk_by(|a, b| b.0 == a.0 + 1) {
                if run.len() < 2 { continue; }
                let mut l = PathBuilder::stroke(px(width));
                l.move_to(point(xp(run[0].0), yp(run[0].1)));
                for q in &run[1..] { l.line_to(point(xp(q.0), yp(q.1))); }
                if let Ok(path) = l.build() { window.paint_path(path, color); }
            }
        };
        line(&|q| q.expected, accent.opacity(0.6), 1.0, window);
        line(&|q| q.observed, ink, 1.5, window);
        line(&|q| q.forecast, accent, 2.0, window);
        for (i, q) in series.points.iter().enumerate() {
            let (Some(m), Some(v)) = (q.marker, q.observed.or(q.forecast)) else { continue };
            let r = 4.0;
            let color = if m == "high" { bad } else { warn };
            window.paint_quad(quad(Bounds::new(point(xp(i) - px(r), yp(v) - px(r)), size(px(2.0 * r), px(2.0 * r))), px(r), color, px(1.), color, BorderStyle::default()));
        }
    }).w_full().h(px(height));
    let fmt = |v: f64| clearline_client::format::group_digits(&format!("{v:.0}"));
    v_flex().id(SharedString::from(id.to_string())).gap_1().w_full()
        .child(h_flex().justify_between().child(div().text_xs().text_color(p.muted).child(series.title.clone())).child(div().text_xs().text_color(p.muted).child(format!("{} – {}", fmt(lo), fmt(hi)))))
        .child(div().w_full().border_1().border_color(p.rule).rounded(px(3.)).p_2().child(plot))
        .child(h_flex().justify_between().child(div().text_xs().text_color(p.muted).child(first)).child(div().text_xs().text_color(p.muted).child(last)))
}
