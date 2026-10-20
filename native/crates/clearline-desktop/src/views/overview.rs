//! Overview: "Is <tenant>'s data trustworthy right now?" Every number is rendered
//! from the operations and business reports; the client computes nothing itself.

use crate::app::{Ctx, Route};
use crate::data::Resource;
use crate::ui::{self, pal, Tone};
use clearline_client::format::{ago, format_value, now_epoch, short_id, when};
use clearline_client::types::{BatchSummary, BusinessSummary, OperationsReport};
use gpui::{div, prelude::*, px, AnyElement, App, Context, FontWeight, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub struct OverviewView {
    c: Ctx,
    ops: Resource<OperationsReport>,
    biz: Resource<BusinessSummary>,
}

impl OverviewView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self {
        let mut v = OverviewView { c, ops: Resource::default(), biz: Resource::default() };
        v.reload(cx);
        v
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.ops.load(cx, self.c.shell.clone(), |v| &mut v.ops, move || cl.operations(&t));
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.biz.load(cx, self.c.shell.clone(), |v| &mut v.biz, move || cl.business(&t));
    }

    pub fn busy(&self) -> bool { self.ops.busy() || self.biz.busy() }

    pub fn snapshot(&self) -> Value {
        json!({
            "view": "overview",
            "verdict": self.ops.ready().map(|o| json!({ "status": o.verdict.status, "summary": o.verdict.summary })),
            "totals": self.ops.ready().map(|o| json!({ "batches": o.totals.batches, "succeeded": o.totals.succeeded, "trusted": o.totals.trusted, "untrusted": o.totals.untrusted,
                "failed": o.totals.failed, "rejected": o.totals.rejected, "in_flight": o.totals.in_flight, "duplicate_submissions": o.totals.duplicate_submissions })),
            "metrics": self.biz.ready().map(|b| b.metrics.iter().map(|m| json!({ "id": m.id, "value": m.value.as_str(), "shown": format_value(m.value.as_str(), &m.unit), "trusted": m.trusted, "withheld": m.withheld })).collect::<Vec<_>>()),
            "recent_batches": self.ops.ready().map(|o| o.recent_batches.iter().map(|b| json!({ "id": b.id, "status": b.status, "trust": b.trust_status })).collect::<Vec<_>>()),
            "error": self.ops.state.error().or(self.biz.state.error()).map(|e| e.user_message()),
        })
    }
}

pub fn batch_table(batches: &[BatchSummary], c: &Ctx, cx: &App) -> AnyElement {
    if batches.is_empty() { return ui::empty("No batches yet. Submit a CSV or JSON batch to a declared source to see it here.", cx).into_any_element(); }
    let p = pal(cx);
    let rows = batches.iter().map(|b| {
        let id = b.id.clone();
        let shell = c.shell.clone();
        vec![
            h_flex().gap_1().child(div().id(gpui::SharedString::from(format!("batch-{}", b.id))).text_color(p.accent).cursor_pointer().child(short_id(&b.id).to_string())
                .on_click(move |_, window, cx| { let _ = shell.update(cx, |s, cx| s.navigate(Route::Batch(id.clone()), window, cx)); }))
                .children(b.is_late.then(|| ui::tag("late", cx))).into_any_element(),
            ui::text(b.source_id.clone()), ui::text(when(b.arrival_at.as_deref())),
            ui::pipeline_signal(&b.status, cx).into_any_element(), ui::trust_signal(&b.trust_status, cx).into_any_element(),
            ui::text(format_value(b.received_count.as_str(), "count")), ui::text(format_value(b.accepted_count.as_str(), "count")),
            ui::text(format_value(b.quarantined_count.as_str(), "count")), ui::text(format_value(b.duplicate_count.as_str(), "count")),
        ]
    }).collect();
    ui::simple_table(&["Batch", "Source", "Arrived", "Ran", "Trusted", "Rows", "Accepted", "Quarantined", "Duplicates"], rows, &[5, 6, 7, 8], cx).into_any_element()
}

fn daily_chart(o: &OperationsReport, cx: &App) -> AnyElement {
    let p = pal(cx);
    if o.daily.is_empty() { return ui::empty("No batches in this window.", cx).into_any_element(); }
    let max = o.daily.iter().map(|d| d.rows_received).max().unwrap_or(1).max(1) as f32;
    let h = 150.0;
    v_flex().gap_2()
        .child(h_flex().gap_4().text_xs().text_color(p.ink2)
            .child(h_flex().gap_1().child(div().size(px(10.)).bg(p.series1)).child("Rows received"))
            .child(h_flex().gap_1().child(div().size(px(10.)).bg(p.series2)).child("Rows quarantined (part of received)")))
        .child(h_flex().items_end().gap_2().h(px(h + 20.)).border_b_1().border_color(p.rule).children(o.daily.iter().map(|d| {
            let bh = (d.rows_received as f32 / max * h).max(1.0);
            let qh = (d.rows_quarantined as f32 / max * h).max(if d.rows_quarantined > 0 { 2.0 } else { 0.0 });
            v_flex().items_center().gap_1()
                .child(div().text_xs().text_color(p.muted).child(format_value(Some(&d.rows_received.to_string()), "count")))
                .child(div().w(px(26.)).h(px(bh)).bg(p.series1).rounded_t(px(4.)).flex().flex_col().justify_end()
                    .child(div().w_full().h(px(qh)).bg(p.series2)))
                .child(div().text_xs().text_color(p.muted).child(d.day.get(5..).unwrap_or(&d.day).to_string()))
        })))
        .into_any_element()
}

impl Render for OverviewView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let tenant = self.c.tenant();
        let mut body = v_flex().w_full();
        let busy = self.busy();
        let verdict: Option<AnyElement> = self.ops.ready().map(|o| {
            let (tone, label) = match o.verdict.status.as_str() { "trusted" => (Tone::Good, "Yes"), "in_progress" => (Tone::Idle, "Processing"), _ => (Tone::Bad, "Needs review") };
            v_flex().gap_1().child(h_flex().child(ui::signal(tone, label, cx))).child(div().text_sm().text_color(p.ink2).max_w(px(720.)).child(o.verdict.summary.clone())).into_any_element()
        });
        body = body.child(ui::page_head(format!("Is {tenant}'s data trustworthy right now?"), verdict,
            Some(Button::new("refresh").primary().label(if busy { "Refreshing…" } else { "Refresh" }).loading(busy)
                .on_click(cx.listener(|this, _, _, cx| this.reload(cx))).into_any_element()), cx));
        for e in [self.ops.state.error(), self.biz.state.error()].into_iter().flatten() { body = body.child(ui::error_state(e, cx)); }
        if self.ops.state.is_loading() && self.ops.ready().is_none() { body = body.child(ui::loading("Loading the operations report…", cx)); }

        if let Some(o) = self.ops.ready() {
            let t = &o.totals;
            let w = |k: &str| o.window.get(k).and_then(|v| v.as_str()).map(|s| when(Some(s))).unwrap_or_default();
            body = body.child(ui::section("ran-vs-trusted", "Ran versus trusted", Some(format!("Batches arriving {} – {}. A batch that ran is not automatically trusted: it must also reconcile and stay under its reject-rate threshold.", w("from"), w("to")).into()),
                h_flex().flex_wrap().gap_x_4()
                    .child(ui::tally("Batches received", t.batches.to_string(), None, cx)).child(ui::tally("Ran to completion", t.succeeded.to_string(), None, cx))
                    .child(ui::tally("Trusted", t.trusted.to_string(), Some(Tone::Good), cx)).child(ui::tally("Not trusted", t.untrusted.to_string(), (t.untrusted > 0).then_some(Tone::Bad), cx))
                    .child(ui::tally("Failed", t.failed.to_string(), (t.failed > 0).then_some(Tone::Bad), cx)).child(ui::tally("Rejected at intake", t.rejected.to_string(), None, cx))
                    .child(ui::tally("In flight", t.in_flight.to_string(), None, cx)).child(ui::tally("Duplicate submissions ignored", t.duplicate_submissions.to_string(), None, cx)), cx));
            let now = now_epoch();
            let rows = o.freshness.iter().map(|f| vec![
                ui::text(f.source_id.clone()), ui::text(f.entity.clone()), ui::text(when(f.last_arrival.as_deref())), ui::text(ago(f.last_trusted.as_deref(), now)),
                ui::text(f.age_hours.as_str().map(|a| format!("{a} h")).unwrap_or("—".into())), ui::text(f.max_age_hours.as_str().map(|a| format!("{a} h")).unwrap_or("—".into())),
                match f.status.as_str() { "fresh" => ui::signal(Tone::Good, "Fresh", cx), "stale" => ui::signal(Tone::Bad, "Stale", cx), _ => ui::signal(Tone::Idle, "No trusted data", cx) }.into_any_element(),
            ]).collect();
            body = body.child(ui::section("freshness", "Freshness by source", Some("Age of the most recent trusted batch per source, against the contract's freshness limit.".into()),
                ui::simple_table(&["Source", "Entity", "Last arrival", "Last trusted", "Age", "Limit", "Status"], rows, &[4, 5], cx), cx));
        }

        if let Some(b) = self.biz.ready() {
            let tiles = b.metrics.iter().map(|m| {
                let border = if m.withheld.is_some() { p.rule_strong } else if m.trusted { p.good } else { p.warn };
                v_flex().w(px(240.)).p_4().gap_2().border_1().border_color(p.rule).border_l_4().border_color(border).rounded(px(4.))
                    .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(p.ink2).child(m.title.clone()))
                    .child(div().text_2xl().font_weight(FontWeight::BOLD).text_color(p.ink).child(if m.withheld.is_some() { "Restricted".to_string() } else { format_value(m.value.as_str(), &m.unit) }))
                    .children(m.withheld.as_ref().map(|w| ui::muted(format!("Withheld: {w}"), cx)))
                    .children((m.trusted).then(|| h_flex().child(ui::signal(Tone::Good, "Covers all received data", cx))))
                    .children(m.untrusted_records_excluded.as_f64().filter(|n| *n > 0.0).map(|_| v_flex().gap_1()
                        .child(h_flex().child(ui::signal(Tone::Warn, format!("{} untrusted records held back", format_value(m.untrusted_records_excluded.as_str(), "count")), cx)))
                        .child(ui::muted(format!("{} if included", format_value(m.value_including_untrusted.as_str(), &m.unit)), cx))))
                    .children((!m.dataset_checks_failing.is_empty()).then(|| v_flex().gap_1().child(h_flex().child(ui::signal(Tone::Warn, "Dataset check failing", cx)))
                        .child(ui::muted(m.dataset_checks_failing.iter().map(|f| f.explanation.clone()).collect::<Vec<_>>().join(" "), cx))))
                    .into_any_element()
            }).chain(std::iter::once(v_flex().w(px(240.)).p_4().gap_2().border_1().border_color(p.rule).border_l_4().border_color(p.good).rounded(px(4.))
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).text_color(p.ink2).child("Exception rate"))
                .child(div().text_2xl().font_weight(FontWeight::BOLD).child(format!("{:.2}%", b.exception_rate.rate * 100.0)))
                .child(ui::muted(format!("{} of {} rows quarantined", b.exception_rate.quarantined, b.exception_rate.received), cx)).into_any_element()));
            body = body.child(ui::section("business", "Business summary", Some(format!("Declared by contract {}. Values use the latest version of each record that came from a trusted batch; where untrusted data was held back, the tile says how much it would change the figure.", b.contract_version).into()),
                h_flex().flex_wrap().gap_3().children(tiles), cx));
        }

        if let Some(o) = self.ops.ready() {
            let lat = |e: &clearline_client::types::Exact| e.as_f64().map(|s| format!("{:.2} s", s)).unwrap_or("—".into());
            body = body.child(ui::section("volume", "Daily volume and quarantine", Some(format!("Latency p50 {}, p95 {} from arrival to completion. Queue: {} waiting, {} processing.", lat(&o.totals.latency_p50_s), lat(&o.totals.latency_p95_s), o.queue.queued, o.queue.processing).into()),
                daily_chart(o, cx), cx));
            body = body.child(ui::section("recent", "Recent batches", Some("Select a batch to see its reconciliation checks, quality results and attempts.".into()), batch_table(&o.recent_batches, &self.c, cx), cx));
            if !o.reconciliation.latest_dataset_run.is_empty() {
                let rows = o.reconciliation.latest_dataset_run.iter().map(|r| vec![ui::text(r.check_id.trim_start_matches("dataset:").to_string()), ui::check_signal(&r.status, cx).into_any_element(), ui::text(r.explanation.clone())]).collect();
                body = body.child(ui::section("dataset", "Dataset reconciliation", Some("Invariants over the whole trusted dataset, re-evaluated after every batch.".into()), ui::simple_table(&["Check", "Result", "Explanation"], rows, &[], cx), cx));
            }
        }
        div().id("overview").size_full().overflow_y_scroll().p_8().child(body)
    }
}
