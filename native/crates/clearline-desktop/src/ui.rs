//! Shared UI primitives: status signals, sections, tallies, facts, notes, simple
//! tables, and the loading / empty / error / permission-denied states every view uses.

use crate::theme::Palette;
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Div, FontWeight, SharedString};
use gpui_component::{h_flex, v_flex};

pub fn pal(cx: &App) -> Palette { *cx.global::<Palette>() }

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tone { Good, Warn, Bad, Idle }

/// Status: icon + word, colour never carries meaning alone.
pub fn signal(tone: Tone, label: impl Into<SharedString>, cx: &App) -> Div {
    let p = pal(cx);
    let (icon, fg, bg) = match tone {
        Tone::Good => ("✓", p.good_ink, p.good_bg),
        Tone::Warn => ("!", p.warn_ink, p.warn_bg),
        Tone::Bad => ("✕", p.bad_ink, p.bad_bg),
        Tone::Idle => ("…", p.ink2, p.idle_bg),
    };
    h_flex().gap_1().px_2().py(px(1.)).rounded(px(10.)).bg(bg).text_color(fg).text_xs().font_weight(FontWeight::SEMIBOLD)
        .child(div().child(icon)).child(label.into())
}

/// A neutral label (no status meaning, so no status icon).
pub fn tag(label: impl Into<SharedString>, cx: &App) -> Div {
    let p = pal(cx);
    div().px_2().py(px(1.)).rounded(px(10.)).bg(p.idle_bg).text_color(p.ink2).text_xs().font_weight(FontWeight::SEMIBOLD).child(label.into())
}

pub fn pipeline_signal(status: &str, cx: &App) -> Div {
    let (t, l) = match status {
        "completed" => (Tone::Good, "Ran"), "completed_with_exceptions" => (Tone::Warn, "Ran with exceptions"), "failed" => (Tone::Bad, "Failed"),
        "rejected" => (Tone::Bad, "Rejected"), "queued" => (Tone::Idle, "Queued"), "processing" => (Tone::Idle, "Processing"), s => (Tone::Idle, s),
    };
    signal(t, l.to_string(), cx)
}

pub fn trust_signal(status: &str, cx: &App) -> Div {
    let (t, l) = match status { "trusted" => (Tone::Good, "Trusted"), "untrusted" => (Tone::Bad, "Not trusted"), "pending" => (Tone::Idle, "Pending"), s => (Tone::Idle, s) };
    signal(t, l.to_string(), cx)
}

pub fn check_signal(status: &str, cx: &App) -> Div {
    match status { "passed" => signal(Tone::Good, "Passed", cx), "failed" => signal(Tone::Bad, "Failed", cx), "warning" => signal(Tone::Warn, "Warning", cx), s => signal(Tone::Idle, s.to_string(), cx) }
}

/// Access level badge for query catalog columns and policy views.
pub fn access_badge(level: &str, cx: &App) -> Div {
    match level {
        "full" => signal(Tone::Good, "full", cx),
        "masked" => signal(Tone::Warn, "masked", cx),
        "filter" => signal(Tone::Warn, "filter only", cx),
        "discover" => signal(Tone::Idle, "listed only", cx),
        "hidden" => signal(Tone::Bad, "hidden", cx),
        s => signal(Tone::Idle, s.to_string(), cx),
    }
}

pub fn page_head(title: impl Into<SharedString>, subtitle: Option<AnyElement>, actions: Option<AnyElement>, cx: &App) -> Div {
    let p = pal(cx);
    h_flex().items_start().justify_between().gap_4().mb_4()
        .child(v_flex().flex_1().min_w(px(0.)).gap_1().child(div().text_2xl().font_weight(FontWeight::BOLD).text_color(p.ink).child(title.into())).children(subtitle))
        .children(actions)
}

pub fn section(id: &'static str, title: impl Into<SharedString>, description: Option<SharedString>, body: impl IntoElement, cx: &App) -> gpui::Stateful<Div> {
    let p = pal(cx);
    v_flex().id(id).mb_4().p_5().gap_3().bg(p.surface).border_1().border_color(p.rule).rounded(px(6.))
        .child(v_flex().gap_1()
            .child(div().text_lg().font_weight(FontWeight::BOLD).text_color(p.ink).child(title.into()))
            .children(description.map(|d| div().text_sm().text_color(p.ink2).max_w(px(760.)).child(d))))
        .child(body)
}

pub fn tally(label: impl Into<SharedString>, value: impl Into<SharedString>, tone: Option<Tone>, cx: &App) -> Div {
    let p = pal(cx);
    let color = match tone { Some(Tone::Good) => p.good_ink, Some(Tone::Bad) => p.bad_ink, _ => p.ink };
    v_flex().min_w(px(150.)).py_2().pr_4().border_b_1().border_color(p.rule)
        .child(div().text_xs().text_color(p.ink2).child(label.into()))
        .child(div().text_2xl().font_weight(FontWeight::BOLD).text_color(color).child(value.into()))
}

pub fn fact(k: impl Into<SharedString>, v: impl IntoElement, cx: &App) -> Div {
    let p = pal(cx);
    v_flex().min_w(px(220.)).max_w(px(420.)).py_1().child(div().text_xs().text_color(p.muted).child(k.into())).child(div().text_sm().text_color(p.ink).child(v))
}

pub fn note(tone: Tone, text: impl Into<SharedString>, cx: &App) -> Div {
    let p = pal(cx);
    let (fg, bg, border) = match tone { Tone::Bad => (p.bad_ink, p.bad_bg, p.bad), Tone::Warn => (p.warn_ink, p.warn_bg, p.warn), Tone::Good => (p.good_ink, p.good_bg, p.good), Tone::Idle => (p.ink2, p.idle_bg, p.rule_strong) };
    div().px_3().py_2().mb_3().rounded(px(4.)).bg(bg).border_l_4().border_color(border).text_sm().text_color(fg).child(text.into())
}

pub fn empty(text: impl Into<SharedString>, cx: &App) -> Div {
    div().py_4().text_sm().text_color(pal(cx).muted).child(text.into())
}

pub fn muted(text: impl Into<SharedString>, cx: &App) -> Div { div().text_sm().text_color(pal(cx).muted).child(text.into()) }
pub fn mono(text: impl Into<SharedString>, cx: &App) -> Div { div().font_family("DejaVu Sans Mono").text_xs().text_color(pal(cx).ink).child(text.into()) }

/// Error state with the right recovery hint; 403 is shown as a permission boundary, not a failure.
pub fn error_state(e: &ApiError, cx: &App) -> Div {
    match e {
        ApiError::Forbidden { .. } => note(Tone::Warn, format!("Not available to your role. {}", e.user_message()), cx),
        ApiError::Network(_) => note(Tone::Bad, e.user_message(), cx),
        _ => note(Tone::Bad, e.user_message(), cx),
    }
}

pub fn loading(label: impl Into<SharedString>, cx: &App) -> Div {
    h_flex().gap_2().py_3().text_sm().text_color(pal(cx).muted).child(div().child("…")).child(label.into())
}

/// A small, non-virtualized table for short lists (a few hundred rows at most).
pub fn simple_table(headers: &[&str], rows: Vec<Vec<AnyElement>>, numeric: &[usize], cx: &App) -> Div {
    simple_table_weighted(headers, rows, numeric, &[], cx)
}

/// Like `simple_table`, with relative column widths (`weights[i]`, default 1).
pub fn simple_table_weighted(headers: &[&str], rows: Vec<Vec<AnyElement>>, numeric: &[usize], weights: &[f32], cx: &App) -> Div {
    let p = pal(cx);
    let weight = |i: usize| weights.get(i).copied().unwrap_or(1.0);
    let sized = |mut d: Div, i: usize| { d.style().flex_grow = Some(weight(i)); d.style().flex_shrink = Some(1.0); d.flex_basis(px(0.)).min_w(px(70.)) };
    let head = h_flex().border_b_1().border_color(p.rule_strong).children(headers.iter().enumerate().map(|(i, h)| {
        let cell = sized(div(), i).py_1().pr_3().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.ink2).child(h.to_string());
        if numeric.contains(&i) { cell.text_right() } else { cell }
    }));
    v_flex().w_full().child(head).children(rows.into_iter().map(|r| {
        h_flex().items_start().border_b_1().border_color(p.rule).children(r.into_iter().enumerate().map(|(i, c)| {
            // A column (not a row) so long text wraps inside the cell instead of running into the next one.
            let cell = sized(v_flex(), i).py(px(6.)).pr_3().text_sm().text_color(p.ink).overflow_hidden().child(c);
            if numeric.contains(&i) { cell.items_end().text_right() } else { cell.items_start() }
        }))
    }))
}

pub fn text(s: impl Into<SharedString>) -> AnyElement { div().child(s.into()).into_any_element() }

/// A toggle chip (filters, choices). The caller attaches the click handler.
pub fn chip(id: impl Into<SharedString>, label: impl Into<SharedString>, on: bool, cx: &App) -> gpui::Stateful<Div> {
    let p = pal(cx);
    div().id(id.into()).px_2().py(px(3.)).rounded(px(4.)).border_1().text_xs().cursor_pointer()
        .border_color(if on { p.accent } else { p.rule_strong }).bg(if on { p.accent } else { p.surface }).text_color(if on { p.accent_ink } else { p.ink2 })
        .child(label.into())
}

/// Severity of an insight or notification as a status signal.
pub fn severity(s: &str, cx: &App) -> Div {
    match s { "high" => signal(Tone::Bad, "high", cx), "medium" => signal(Tone::Warn, "medium", cx), "low" => signal(Tone::Warn, "low", cx), _ => tag("info", cx) }
}

/// Run / phase status as a status signal.
pub fn run_signal(status: &str, cx: &App) -> Div {
    let (t, l) = match status {
        "succeeded" | "delivered" | "active" => (Tone::Good, status), "paused" => (Tone::Warn, status), "failed" | "denied" | "blocked" | "timed_out" => (Tone::Bad, status),
        "partial" | "delivering" | "retrying" | "pending" | "queued" | "running" | "sending" => (Tone::Warn, status), s => (Tone::Idle, s),
    };
    signal(t, l.replace('_', " "), cx)
}
