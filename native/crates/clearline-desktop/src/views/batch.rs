//! Batch detail: provenance, dispositions, reconciliation (expected vs actual,
//! explained), quality results with per-record findings, attempts and submissions.

use crate::app::{Ctx, Route};
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use clearline_client::format::{cell, format_value, when};
use clearline_client::types::BatchDetail;
use gpui::{div, prelude::*, Context, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub struct BatchView {
    c: Ctx,
    pub id: String,
    detail: Resource<BatchDetail>,
    rule: Option<String>,
    findings: Resource<Vec<Value>>,
    notice: Option<String>,
    task: Option<Task<()>>,
}

fn compact(v: &Value) -> String {
    match v {
        Value::Object(m) => m.iter().map(|(k, x)| format!("{} {}", k.replace('_', " "), cell(x))).collect::<Vec<_>>().join(" · "),
        Value::Null => "—".into(),
        other => cell(other),
    }
}

impl BatchView {
    pub fn new(c: Ctx, id: String, cx: &mut Context<Self>) -> Self {
        let mut v = BatchView { c, id: String::new(), detail: Resource::default(), rule: None, findings: Resource::default(), notice: None, task: None };
        v.open(id, cx);
        v
    }

    pub fn open(&mut self, id: String, cx: &mut Context<Self>) {
        self.id = id.clone();
        self.rule = None;
        self.notice = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.detail.load(cx, self.c.shell.clone(), |v| &mut v.detail, move || cl.batch(&t, &id));
    }

    pub fn busy(&self) -> bool { self.detail.busy() || self.findings.busy() }

    fn show_rule(&mut self, rule: String, cx: &mut Context<Self>) {
        self.rule = Some(rule.clone());
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        self.findings.load(cx, self.c.shell.clone(), |v| &mut v.findings, move || cl.findings(&t, &id, &rule));
        cx.notify();
    }

    fn replay(&mut self, cx: &mut Context<Self>) {
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.replay(&t, &id), |this: &mut Self, r, cx| {
            this.notice = Some(match r { Ok(_) => "Batch re-queued. A worker will pick it up shortly.".into(), Err(e) => e.user_message() });
            let id = this.id.clone();
            this.open(id, cx);
        }));
    }

    pub fn snapshot(&self) -> Value {
        json!({ "view": "batch", "id": self.id, "status": self.detail.ready().map(|d| d.status.clone()), "trust": self.detail.ready().map(|d| d.trust_status.clone()),
            "reconciliation": self.detail.ready().map(|d| d.reconciliation.iter().map(|r| json!({ "check_id": r.get("check_id"), "status": r.get("status"), "explanation": r.get("explanation") })).collect::<Vec<_>>()),
            "findings": self.findings.ready().map(|f| f.iter().take(20).cloned().collect::<Vec<_>>()), "error": self.detail.state.error().map(|e| e.user_message()) })
    }
}

impl Render for BatchView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let shell = self.c.shell.clone();
        let back = div().id("back").text_sm().text_color(p.accent).cursor_pointer().child("Back to overview")
            .on_click(move |_, window, cx| { let _ = shell.update(cx, |s, cx| s.navigate(Route::Overview, window, cx)); });
        let mut body = v_flex().w_full().child(back);
        let d = match &self.detail.state {
            crate::data::Load::Ready(d) => d.clone(),
            crate::data::Load::Failed(e) => return div().id("batch").size_full().p_8().child(body.child(ui::error_state(e, cx))).into_any_element(),
            _ => return div().id("batch").size_full().p_8().child(body.child(ui::loading("Loading the batch…", cx))).into_any_element(),
        };
        let can_replay = d.status == "failed" && self.c.can("batch:replay");
        body = body.child(ui::page_head(format!("Batch {}", &d.id[..8]), Some(v_flex().gap_1().child(ui::muted(d.id.clone(), cx))
            .child(h_flex().gap_2().child(ui::pipeline_signal(&d.status, cx)).child(ui::trust_signal(&d.trust_status, cx)).child(ui::muted(d.trust_reasons.join("; "), cx))).into_any_element()),
            can_replay.then(|| Button::new("replay").primary().label("Replay batch").on_click(cx.listener(|this, _, _, cx| this.replay(cx))).into_any_element()), cx));
        if let Some(n) = &self.notice { body = body.child(ui::note(Tone::Idle, n.clone(), cx)); }
        let c = |k: &str| d.counts.get(k).map(cell).unwrap_or("—".into());
        body = body.child(ui::section("provenance", "Provenance", None, h_flex().flex_wrap().gap_x_6()
            .child(ui::fact("Source", div().child(format!("{} ({})", d.source_id, d.format)), cx)).child(ui::fact("Entity", div().child(d.entity.clone()), cx))
            .child(ui::fact("Contract version", div().child(d.contract_version.clone()), cx)).child(ui::fact("Transform version", div().child(d.transform_version.clone()), cx))
            .child(ui::fact("Payload SHA-256", ui::mono(d.payload_digest.clone(), cx), cx)).child(ui::fact("Size", div().child(format!("{} bytes", format_value(d.byte_size.as_str(), "count"))), cx))
            .child(ui::fact("Arrived", div().child(when(d.arrival_at.as_deref())), cx)).child(ui::fact("Completed", div().child(when(d.completed_at.as_deref())), cx))
            .child(ui::fact("Submitted by", div().child(d.submitted_by.clone()), cx)).child(ui::fact("Processing run", div().child(d.processing_run_id.clone().unwrap_or("—".into())), cx))
            .child(ui::fact("Control totals", div().child(compact(d.counts.get("control").unwrap_or(&Value::Null))), cx)), cx));
        body = body.child(ui::section("counts", "Record dispositions", Some("Every received row has exactly one disposition.".into()), h_flex().flex_wrap().gap_x_4()
            .children([("Received", "received_count"), ("Accepted", "accepted_count"), ("Quarantined", "quarantined_count"), ("Exact duplicates", "duplicate_count"),
                ("Late (kept as history)", "late_record_count"), ("Corrections", "correction_count"), ("Conflicts", "conflict_count"), ("Warnings", "warning_count")]
                .into_iter().map(|(l, k)| ui::tally(l, c(k), None, cx))), cx));
        let rec = d.reconciliation.iter().map(|r| vec![ui::text(r.get("check_id").map(cell).unwrap_or_default()), ui::check_signal(r.get("status").and_then(Value::as_str).unwrap_or(""), cx).into_any_element(),
            ui::text(compact(r.get("expected").unwrap_or(&Value::Null))), ui::text(compact(r.get("actual").unwrap_or(&Value::Null))), ui::text(compact(r.get("difference").unwrap_or(&Value::Null))),
            ui::text(r.get("explanation").map(cell).unwrap_or_default())]).collect::<Vec<_>>();
        body = body.child(ui::section("recon", "Reconciliation", Some("Expected versus actual, with the difference explained.".into()),
            if rec.is_empty() { ui::empty("Reconciliation runs when the batch is processed.", cx).into_any_element() } else { ui::simple_table(&["Check", "Result", "Expected", "Actual", "Difference", "Explanation"], rec, &[], cx).into_any_element() }, cx));
        let can_findings = self.c.can("quarantine:read");
        let quality = d.quality_results.iter().map(|q| {
            let rule = q.get("rule_id").map(cell).unwrap_or_default();
            let failed = q.get("failed_count").and_then(Value::as_i64).unwrap_or(0);
            let r2 = rule.clone();
            vec![
                if failed > 0 && can_findings { div().id(SharedString::from(format!("rule-{rule}"))).text_color(p.accent).cursor_pointer().child(rule.clone()).on_click(cx.listener(move |this, _, _, cx| this.show_rule(r2.clone(), cx))).into_any_element() } else { ui::text(rule.clone()) },
                ui::text(q.get("category").map(cell).unwrap_or_default()), ui::text(q.get("severity").map(cell).unwrap_or_default()),
                ui::text(q.get("evaluated_count").map(cell).unwrap_or_default()), ui::text(failed.to_string()), ui::text(q.get("description").map(cell).unwrap_or_default()),
            ]
        }).collect();
        let mut qsec = v_flex().gap_3().child(ui::simple_table(&["Rule", "Category", "Severity", "Evaluated", "Failed", "Description"], quality, &[3, 4], cx));
        if let Some(rule) = &self.rule {
            qsec = qsec.child(div().font_weight(gpui::FontWeight::BOLD).child(format!("Rows failing {rule}")));
            qsec = match &self.findings.state {
                crate::data::Load::Ready(f) => qsec.child(ui::simple_table(&["Source row", "Field", "Severity", "Reason"], f.iter().map(|x| vec![
                    ui::text(x.get("source_row").map(cell).unwrap_or_default()), ui::text(x.get("field").map(cell).unwrap_or_default()),
                    ui::text(x.get("severity").map(cell).unwrap_or_default()), ui::text(x.get("message").map(cell).unwrap_or_default())]).collect(), &[0], cx)),
                crate::data::Load::Failed(e) => qsec.child(ui::error_state(e, cx)),
                _ => qsec.child(ui::loading("Loading findings…", cx)),
            };
        }
        body = body.child(ui::section("quality", "Quality results", Some(if can_findings { "Select a rule with failures to list the affected source rows.".into() } else { "Per-record findings are visible to operators and administrators.".into() }), qsec, cx));
        let attempts = d.attempts.iter().map(|a| vec![ui::text(a.get("attempt").map(cell).unwrap_or_default()), ui::text(a.get("worker_id").map(cell).unwrap_or_default()),
            ui::text(when(a.get("started_at").and_then(Value::as_str))), ui::text(a.get("outcome").map(cell).unwrap_or_default()), ui::text(a.pointer("/error/message").map(cell).unwrap_or_default())]).collect();
        body = body.child(ui::section("attempts", "Attempts", None, ui::simple_table(&["Attempt", "Worker", "Started", "Outcome", "Error"], attempts, &[], cx), cx));
        div().id("batch").size_full().overflow_y_scroll().p_8().child(body).into_any_element()
    }
}
