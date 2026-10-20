//! Execution and delivery history across saved queries: every run with its trigger, phases,
//! failure class, duration and delivery summary. Opening a run shows its detail.

use crate::app::{Ctx, Route};
use crate::data::Resource;
use crate::ui::{self, pal};
use clearline_client::format::when;
use clearline_client::types::RunList;
use gpui::{div, prelude::*, px, Context, SharedString, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub const FILTERS: &[(&str, &str)] = &[("", "All"), ("failed", "Failed"), ("denied", "Denied"), ("delivering", "Delivering"), ("succeeded", "Succeeded"), ("queued", "Queued")];

pub struct RunsView { c: Ctx, data: Resource<RunList>, pub status: &'static str }

impl RunsView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self { let mut v = RunsView { c, data: Resource::default(), status: "" }; v.reload(cx); v }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        let q = if self.status.is_empty() { "?limit=200".to_string() } else { format!("?limit=200&status={}", self.status) };
        self.data.load(cx, self.c.shell.clone(), |v| &mut v.data, move || cl.runs(&t, &q));
    }
    pub fn set_status(&mut self, s: &'static str, cx: &mut Context<Self>) { self.status = s; self.reload(cx); }
    pub fn busy(&self) -> bool { self.data.busy() }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "runs", "status": self.status, "error": self.data.state.error().map(|e| e.user_message()),
            "items": self.data.ready().map(|l| l.items.iter().map(|i| json!({ "id": i.run.id, "query": i.query_name, "status": i.run.status, "trigger": i.run.trigger,
                "query_status": i.run.query_status, "analysis_status": i.run.analysis_status, "delivery_status": i.run.delivery_status, "failure_class": i.run.failure_class })).collect::<Vec<_>>()) })
    }
}

impl Render for RunsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let mut body = v_flex().w_full().gap_3().child(ui::page_head("Run history", Some(ui::muted("Scheduled and manual runs of saved queries. Query, analysis and delivery outcomes are reported separately.", cx).into_any_element()),
            Some(Button::new("runs-refresh").primary().label("Refresh").loading(self.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx))).into_any_element()), cx))
            .child(h_flex().gap_1().children(FILTERS.iter().map(|(s, l)| { let s2: &'static str = s; ui::chip(SharedString::from(format!("rf-{l}")), *l, self.status == *s, cx).on_click(cx.listener(move |this, _, _, cx| this.set_status(s2, cx))) })));
        if let Some(e) = self.data.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(l) = self.data.ready() {
            let rows = l.items.iter().map(|i| {
                let id = i.run.id.clone();
                let total = i.run.timings.get("query_ms").and_then(Value::as_f64).unwrap_or(0.0) + i.run.timings.get("analysis_ms").and_then(Value::as_f64).unwrap_or(0.0);
                let deliveries = i.deliveries.iter().map(|d| format!("{} {}", d["n"], d["status"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", ");
                vec![div().id(SharedString::from(format!("rl-{}", i.run.id))).text_color(p.accent).cursor_pointer().child(i.query_name.clone())
                        .on_click(cx.listener(move |this, _, window, cx| { let s = this.c.shell.clone(); let _ = s.update(cx, |s, cx| s.navigate(Route::Run(id.clone()), window, cx)); })).into_any_element(),
                    ui::text(i.run.trigger.clone()), ui::run_signal(&i.run.status, cx).into_any_element(),
                    ui::text(format!("query {} · analyses {} · delivery {}", i.run.query_status, i.run.analysis_status.replace('_', " "), i.run.delivery_status).replace("not configured", "none")), ui::text(i.run.failure_class.clone().unwrap_or_default()),
                    ui::text(format!("{total:.0} ms")), ui::text(if deliveries.is_empty() { "—".into() } else { deliveries }), ui::text(when(i.run.created_at.as_deref()))]
            }).collect();
            body = body.child(if l.items.is_empty() { ui::empty("No runs yet.", cx).into_any_element() }
                else { ui::simple_table_weighted(&["Saved query", "Trigger", "Status", "Phases", "Failure", "Query + analysis", "Deliveries", "When"], rows, &[5], &[1.6, 0.7, 0.8, 1.6, 0.8, 0.8, 1.2, 1.1], cx).into_any_element() });
        } else if self.busy() { body = body.child(ui::loading("Loading runs…", cx)); }
        div().id("runs").size_full().overflow_y_scroll().p_8().child(body).child(div().h(px(8.)))
    }
}
