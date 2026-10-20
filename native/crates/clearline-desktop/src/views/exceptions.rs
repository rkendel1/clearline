//! Exceptions: quarantined records with actionable reasons, orphaned references,
//! and batches requiring review. Keys and values follow the role's field policy.

use crate::app::{Ctx, Route};
use crate::data::Resource;
use crate::ui::{self, pal};
use clearline_client::format::{cell, short_id, when};
use clearline_client::types::ExceptionReport;
use gpui::{div, prelude::*, AnyElement, Context, SharedString, Window};
use gpui_component::{button::{Button, ButtonVariants}, v_flex};
use serde_json::{json, Value};

pub struct ExceptionsView { c: Ctx, report: Resource<ExceptionReport> }

impl ExceptionsView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self {
        let mut v = ExceptionsView { c, report: Resource::default() };
        v.reload(cx);
        v
    }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.report.load(cx, self.c.shell.clone(), |v| &mut v.report, move || cl.exceptions(&t));
    }
    pub fn busy(&self) -> bool { self.report.busy() }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "exceptions", "quarantined": self.report.ready().map(|r| r.quarantined.iter().map(|q| json!({ "key": q.record_key, "category": q.category, "reasons": q.reasons.iter().map(|x| x.message.clone()).collect::<Vec<_>>() })).collect::<Vec<_>>()),
            "orphans": self.report.ready().map(|r| r.orphaned_references.len()), "error": self.report.state.error().map(|e| e.user_message()) })
    }
}

fn batch_link(c: &Ctx, id: &str, salt: &str, cx: &gpui::App) -> AnyElement {
    let (shell, bid) = (c.shell.clone(), id.to_string());
    div().id(SharedString::from(format!("x-{salt}-{id}"))).text_color(pal(cx).accent).cursor_pointer().child(short_id(id).to_string())
        .on_click(move |_, window, cx| { let _ = shell.update(cx, |s, cx| s.navigate(Route::Batch(bid.clone()), window, cx)); }).into_any_element()
}

impl Render for ExceptionsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut body = v_flex().w_full().child(ui::page_head("Exceptions", Some(ui::muted("Quarantined source rows, references to records that have not arrived, and batches that need review.", cx).into_any_element()),
            Some(Button::new("refresh-x").primary().label("Refresh").loading(self.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx))).into_any_element()), cx));
        if let Some(e) = self.report.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(r) = self.report.ready() {
            let q = r.quarantined.iter().enumerate().map(|(i, q)| vec![batch_link(&self.c, &q.batch_id, &format!("q{i}"), cx), ui::text(q.source_id.clone()), ui::text(q.source_row.as_str().unwrap_or("").to_string()),
                ui::text(q.entity.clone()), ui::text(q.record_key.clone().unwrap_or("—".into())), ui::text(q.category.clone()),
                ui::text(q.reasons.iter().map(|x| x.message.clone()).collect::<Vec<_>>().join("; "))]).collect::<Vec<_>>();
            body = body.child(ui::section("quarantine", "Quarantined records", Some("Each row lists exactly why it was held back. Resubmit corrected data to admit it.".into()),
                if q.is_empty() { ui::empty("Nothing is quarantined.", cx).into_any_element() } else { ui::simple_table(&["Batch", "Source", "Row", "Entity", "Key", "Category", "Reasons"], q, &[2], cx).into_any_element() }, cx));
            let o = r.orphaned_references.iter().enumerate().map(|(i, o)| vec![ui::text(o.entity.clone()), ui::text(cell(&o.key)), ui::text(format!("{} → {}", o.relationship, o.references)),
                ui::text(cell(&o.missing_reference)), batch_link(&self.c, &o.batch_id, &format!("o{i}"), cx)]).collect::<Vec<_>>();
            body = body.child(ui::section("orphans", "References to records that have not arrived", None,
                if o.is_empty() { ui::empty("Every reference resolves.", cx).into_any_element() } else { ui::simple_table(&["Entity", "Key", "Relationship", "Missing reference", "Batch"], o, &[], cx).into_any_element() }, cx));
            let rv = r.batches_requiring_review.iter().enumerate().map(|(i, b)| vec![batch_link(&self.c, b.get("id").and_then(Value::as_str).unwrap_or(""), &format!("r{i}"), cx),
                ui::text(b.get("source_id").map(cell).unwrap_or_default()), ui::pipeline_signal(b.get("status").and_then(Value::as_str).unwrap_or(""), cx).into_any_element(),
                ui::trust_signal(b.get("trust_status").and_then(Value::as_str).unwrap_or(""), cx).into_any_element(), ui::text(when(b.get("arrival_at").and_then(Value::as_str)))]).collect::<Vec<_>>();
            body = body.child(ui::section("review", "Batches requiring review", None,
                if rv.is_empty() { ui::empty("No batch needs review.", cx).into_any_element() } else { ui::simple_table(&["Batch", "Source", "Ran", "Trusted", "Arrived"], rv, &[], cx).into_any_element() }, cx));
        } else if self.busy() { body = body.child(ui::loading("Loading exceptions…", cx)); }
        div().id("exceptions").size_full().overflow_y_scroll().p_8().child(body)
    }
}
