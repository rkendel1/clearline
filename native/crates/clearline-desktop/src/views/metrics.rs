//! Metric definitions: contract-declared metrics and platform-defined ones, exactly
//! as the API defines them (source, filters, aggregation, trust scope, refresh).

use crate::app::Ctx;
use crate::data::Resource;
use crate::ui;
use clearline_client::format::cell;
use clearline_client::types::MetricDefinitions;
use gpui::{div, prelude::*, Context, Window};
use gpui_component::v_flex;
use serde_json::{json, Value};

pub struct MetricsView { c: Ctx, defs: Resource<MetricDefinitions> }

impl MetricsView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self {
        let mut v = MetricsView { c, defs: Resource::default() };
        let (cl, t) = (v.c.client(), v.c.tenant());
        v.defs.load(cx, v.c.shell.clone(), |v| &mut v.defs, move || cl.metric_definitions(&t));
        v
    }
    pub fn busy(&self) -> bool { self.defs.busy() }
    pub fn snapshot(&self) -> Value { json!({ "view": "metrics", "declared": self.defs.ready().map(|d| d.declared.iter().map(|m| m.get("id").cloned()).collect::<Vec<_>>()) }) }
}

impl Render for MetricsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mut body = v_flex().w_full().child(ui::page_head("Metric definitions", Some(ui::muted("How every reported number is computed. The overview and reports use these definitions, and nothing else.", cx).into_any_element()), None, cx));
        if let Some(e) = self.defs.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(d) = self.defs.ready() {
            let f = |m: &Value, k: &str| m.get(k).map(|v| if v.is_object() || v.is_array() { v.to_string() } else { cell(v) }).unwrap_or_default();
            let rows = d.declared.iter().map(|m| vec![ui::text(f(m, "title")), ui::text(f(m, "entity")), ui::text(format!("{}({})", f(m, "aggregation"), m.get("field").and_then(Value::as_str).unwrap_or("*"))),
                ui::text(if m.get("filter").is_some_and(|x| !x.is_null()) { f(m, "filter") } else { "—".into() }), ui::text(f(m, "trust_scope")), ui::text(f(m, "description"))]).collect();
            body = body.child(ui::section("declared", format!("Declared by contract {}", d.contract_version.clone().unwrap_or_default()), None,
                ui::simple_table(&["Metric", "Entity", "Aggregation", "Filter", "Trust scope", "Description"], rows, &[], cx), cx));
            let prow = d.platform.iter().map(|m| vec![ui::text(f(m, "id")), ui::text(f(m, "title")), ui::text(f(m, "definition"))]).collect();
            body = body.child(ui::section("platform", "Platform-defined", None, ui::simple_table(&["Id", "Title", "Definition"], prow, &[], cx), cx));
        } else if self.busy() { body = body.child(ui::loading("Loading definitions…", cx)); }
        div().id("metrics").size_full().overflow_y_scroll().p_8().child(body)
    }
}
