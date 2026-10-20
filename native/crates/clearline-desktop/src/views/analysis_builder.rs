//! Analysis builder: choose an analysis type and algorithm, map the saved query's output
//! columns to its inputs (time column, metrics or features, identifier, comparison group),
//! set sensitivity and minimum-data parameters, validate against the server, and add it to the
//! saved query (a new version). Redacted or sensitive columns are offered but marked: the
//! server refuses them as inputs.

use crate::app::Ctx;
use crate::data::spawn_fetch;
use crate::ui::{self, pal, Tone};
use crate::views::library::LibraryView;
use clearline_client::types::{AnalysisCheck, SchemaColumn};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, FontWeight, SharedString, Task, WeakEntity, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputState}, v_flex, Disableable, Sizable};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub const TYPES: &[(&str, &str, &[&str])] = &[
    ("anomaly", "Time-series anomalies", &["anomaly.rolling_mad", "anomaly.seasonal_decomposition"]),
    ("forecast", "Forecast", &["forecast.auto", "forecast.naive", "forecast.seasonal_naive", "forecast.drift", "forecast.holt_linear"]),
    ("outlier", "Outlier records", &["outlier.robust_distance"]),
    ("cluster", "Segments (k-means)", &["cluster.kmeans"]),
];
const NUMERIC: &[&str] = &["integer", "decimal"];
const TIME: &[&str] = &["date", "timestamp"];
const GRAINS: &[&str] = &["day", "week", "month", "hour"];

pub struct AnalysisBuilder {
    c: Ctx,
    library: WeakEntity<LibraryView>,
    query_id: Option<String>,
    pub schema: Vec<SchemaColumn>,
    pub existing: Vec<Value>,
    pub kind: &'static str,
    pub algorithm: &'static str,
    pub grain: &'static str,
    pub time_column: Option<String>,
    pub columns: BTreeSet<String>,
    pub id_column: Option<String>,
    pub group_by: Option<String>,
    inputs: Vec<(&'static str, Entity<InputState>)>,
    pub check: Option<AnalysisCheck>,
    pub error: Option<ApiError>,
    pub notice: Option<(Tone, String)>,
    busy: bool,
    task: Option<Task<()>>,
}

/// Numeric parameters by name, with the default shown as placeholder (empty = server default).
const PARAMS: &[(&str, &str, &str)] = &[
    ("key", "Key", "e.g. daily-paid"), ("label", "Label", "shown on insights"), ("period", "Seasonal period", "e.g. 7 (weekly in daily data)"), ("window", "Baseline window", "28, or 8 with a period"),
    ("threshold", "Threshold (robust z)", "3.5"), ("min_history", "Minimum history", "auto"), ("recent_points", "Alert on last n points", "all"),
    ("horizon", "Horizon", "8"), ("backtest_origins", "Backtest origins", "8"), ("above", "Alert if forecast above", "none"), ("below", "Alert if forecast below", "none"),
    ("k", "Clusters (k)", "3"), ("seed", "Seed", "42"), ("min_samples", "Minimum samples", "30"), ("top_n", "Top n", "25"),
];

impl AnalysisBuilder {
    pub fn new(c: Ctx, library: WeakEntity<LibraryView>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let inputs = PARAMS.iter().map(|(k, _, ph)| (*k, cx.new(|cx| InputState::new(window, cx).placeholder(ph.to_string())))).collect();
        AnalysisBuilder { c, library, query_id: None, schema: vec![], existing: vec![], kind: "anomaly", algorithm: "anomaly.rolling_mad", grain: "day", time_column: None, columns: BTreeSet::new(),
            id_column: None, group_by: None, inputs, check: None, error: None, notice: None, busy: false, task: None }
    }

    pub fn set_query(&mut self, id: String, schema: Vec<SchemaColumn>, existing: Vec<Value>, _window: &mut Window, cx: &mut Context<Self>) {
        self.query_id = Some(id);
        self.time_column = schema.iter().find(|c| TIME.contains(&c.ty.as_str())).map(|c| c.name.clone());
        self.schema = schema;
        self.existing = existing;
        self.columns.clear(); self.id_column = None; self.group_by = None; self.check = None; self.error = None;
        cx.notify();
    }

    pub fn busy(&self) -> bool { self.busy }

    pub fn set_kind(&mut self, k: &'static str, cx: &mut Context<Self>) {
        self.kind = k;
        self.algorithm = TYPES.iter().find(|t| t.0 == k).map(|t| t.2[0]).unwrap_or("anomaly.rolling_mad");
        self.columns.clear(); self.check = None;
        cx.notify();
    }
    pub fn set_algorithm(&mut self, a: &'static str, cx: &mut Context<Self>) { self.algorithm = a; self.check = None; cx.notify(); }
    pub fn set_grain(&mut self, g: &'static str, cx: &mut Context<Self>) { self.grain = g; cx.notify(); }
    pub fn toggle_column(&mut self, c: String, cx: &mut Context<Self>) {
        if self.kind == "forecast" { self.columns = BTreeSet::from([c]); } else if !self.columns.remove(&c) { self.columns.insert(c); }
        self.check = None; cx.notify();
    }
    pub fn set_time(&mut self, c: String, cx: &mut Context<Self>) { self.time_column = Some(c); cx.notify(); }
    pub fn set_id(&mut self, c: Option<String>, cx: &mut Context<Self>) { self.id_column = c; cx.notify(); }
    pub fn set_group(&mut self, c: Option<String>, cx: &mut Context<Self>) { self.group_by = c; cx.notify(); }
    pub fn set_param(&mut self, k: &str, v: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((_, i)) = self.inputs.iter().find(|(n, _)| *n == k) else { return false };
        i.update(cx, |s, cx| s.set_value(v.to_string(), window, cx));
        true
    }

    fn val(&self, k: &str, cx: &App) -> Option<String> { self.inputs.iter().find(|(n, _)| *n == k).map(|(_, i)| i.read(cx).value().trim().to_string()).filter(|s| !s.is_empty()) }
    fn num(&self, k: &str, cx: &App) -> Option<Value> { self.val(k, cx).and_then(|s| s.parse::<f64>().ok()).map(|n| if n.fract() == 0.0 { json!(n as i64) } else { json!(n) }) }

    pub fn config(&self, cx: &App) -> Value {
        let mut m = Map::new();
        m.insert("type".into(), json!(self.kind));
        m.insert("algorithm".into(), json!(self.algorithm));
        m.insert("key".into(), json!(self.val("key", cx).unwrap_or_else(|| format!("{}-{}", self.kind, self.existing.len() + 1))));
        if let Some(l) = self.val("label", cx) { m.insert("label".into(), json!(l)); }
        let cols: Vec<&String> = self.columns.iter().collect();
        match self.kind {
            "anomaly" | "forecast" => {
                m.insert("time_column".into(), json!(self.time_column));
                m.insert("grain".into(), json!(self.grain));
                if self.kind == "anomaly" { m.insert("metrics".into(), json!(cols)); } else { m.insert("metric".into(), json!(cols.first())); }
            }
            _ => {
                m.insert("features".into(), json!(cols));
                m.insert("id_column".into(), json!(self.id_column));
                if self.kind == "outlier" { m.insert("group_by".into(), json!(self.group_by)); }
            }
        }
        let keys: &[&str] = match self.kind {
            "anomaly" => &["period", "window", "threshold", "min_history", "recent_points"],
            "forecast" => &["period", "horizon", "backtest_origins", "min_history"],
            "outlier" => &["threshold", "min_samples", "top_n"],
            _ => &["k", "seed"],
        };
        for k in keys { if let Some(v) = self.num(k, cx) { m.insert(k.to_string(), v); } }
        if self.kind == "forecast" { m.insert("thresholds".into(), json!({ "above": self.num("above", cx), "below": self.num("below", cx) })); }
        Value::Object(m)
    }

    pub fn validate(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.query_id.clone() else { return };
        let (cl, t, cfg) = (self.c.client(), self.c.tenant(), self.config(cx));
        self.busy = true; self.error = None; self.notice = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.validate_analysis(&t, &id, &cfg), |this: &mut Self, r, _| {
            this.busy = false;
            match r { Ok(c) => this.check = Some(c), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    /// Save the analyses as a new version: existing ones (minus `remove`) plus the configured one when `add`.
    fn save(&mut self, add: bool, remove: Option<usize>, cx: &mut Context<Self>) {
        let Some(id) = self.query_id.clone() else { return };
        let mut list: Vec<Value> = self.existing.iter().enumerate().filter(|(i, _)| Some(*i) != remove).map(|(_, a)| {
            let mut a = a.clone();
            if let Some(o) = a.as_object_mut() { o.remove("state"); o.remove("state_reason"); }
            a
        }).collect();
        if add { list.push(self.config(cx)); }
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.busy = true; self.error = None;
        let lib = self.library.clone();
        let note = if add { "Added an analysis" } else { "Removed an analysis" };
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.new_version(&t, &id, &json!({ "analyses": list, "change_note": note })), move |this: &mut Self, r, cx| {
            this.busy = false;
            match r {
                Ok(d) => {
                    this.notice = Some((Tone::Good, format!("Saved as version {}; the next run includes it.", d.version)));
                    this.check = None;
                    let _ = lib.update(cx, |l, cx| l.refresh_selected(cx));
                }
                Err(e) => this.error = Some(e),
            }
        }));
        cx.notify();
    }
    pub fn add(&mut self, cx: &mut Context<Self>) { self.save(true, None, cx); }
    pub fn remove(&mut self, i: usize, cx: &mut Context<Self>) { self.save(false, Some(i), cx); }

    pub fn snapshot(&self, cx: &App) -> Value {
        json!({ "kind": self.kind, "algorithm": self.algorithm, "config": self.config(cx), "existing": self.existing, "busy": self.busy,
            "check": self.check.as_ref().map(|c| json!({ "ok": c.ok, "issues": c.issues })), "notice": self.notice.as_ref().map(|n| n.1.clone()),
            "error": self.error.as_ref().map(|e| json!({ "code": e.code(), "message": e.user_message() })) })
    }

    fn column_chips(&self, filter: &[&str], selected: &dyn Fn(&str) -> bool, prefix: &str, on: fn(&mut Self, String, &mut Context<Self>), cx: &mut Context<Self>) -> AnyElement {
        h_flex().flex_wrap().gap_1().children(self.schema.iter().filter(|c| filter.is_empty() || filter.contains(&c.ty.as_str())).map(|c| {
            let name = c.name.clone();
            let label = if let Some(m) = &c.masked { format!("{} (redacted {m})", c.name) } else if c.sensitive { format!("{} (sensitive)", c.name) } else { format!("{} · {}", c.name, c.ty) };
            ui::chip(SharedString::from(format!("{prefix}-{}", c.name)), label, selected(&c.name), cx).on_click(cx.listener(move |this, _, _, cx| on(this, name.clone(), cx)))
        })).into_any_element()
    }
}

impl Render for AnalysisBuilder {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let row = |label: &str, content: AnyElement| h_flex().gap_3().items_start().child(div().w(px(140.)).pt_1().text_xs().text_color(p.ink2).child(label.to_string())).child(div().flex_1().child(content));
        // Existing analyses on the current version.
        let existing: Vec<Vec<AnyElement>> = self.existing.iter().enumerate().map(|(i, a)| {
            let s = |k: &str| a.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let state = s("state");
            let reason = a.get("state_reason").and_then(Value::as_str).unwrap_or("").to_string();
            vec![v_flex().child(div().text_sm().child(if s("label").is_empty() { s("key") } else { s("label") })).child(ui::muted(format!("{} · {}", s("key"), s("type")), cx)).into_any_element(),
                ui::mono(s("algorithm"), cx).into_any_element(),
                v_flex().gap_1().child(if state == "needs_revalidation" { ui::signal(Tone::Warn, "needs revalidation", cx) } else { ui::signal(Tone::Good, "active", cx) })
                    .children((!reason.is_empty()).then(|| ui::muted(reason, cx))).into_any_element(),
                Button::new(SharedString::from(format!("an-rm-{i}"))).small().label("Remove").on_click(cx.listener(move |this, _, _, cx| this.remove(i, cx))).into_any_element()]
        }).collect();
        let mut col = v_flex().gap_3().child(ui::section("analyses-current", "Analyses on this version", Some("They run after every run of the saved query, on its authorized, bounded result.".into()),
            if existing.is_empty() { ui::empty("None yet.", cx).into_any_element() } else { ui::simple_table_weighted(&["Analysis", "Algorithm", "State", ""], existing, &[], &[1.6, 1.5, 1.6, 0.6], cx).into_any_element() }, cx));
        let mut form = v_flex().gap_2()
            .child(row("Analysis", h_flex().flex_wrap().gap_1().children(TYPES.iter().map(|(k, label, _)| {
                let k2: &'static str = k;
                ui::chip(SharedString::from(format!("atype-{k}")), *label, self.kind == *k, cx).on_click(cx.listener(move |this, _, _, cx| this.set_kind(k2, cx)))
            })).into_any_element()))
            .child(row("Algorithm", h_flex().flex_wrap().gap_1().children(TYPES.iter().find(|t| t.0 == self.kind).map(|t| t.2).unwrap_or(&[]).iter().map(|a| {
                let a2: &'static str = a;
                ui::chip(SharedString::from(format!("algo-{a}")), *a, self.algorithm == *a, cx).on_click(cx.listener(move |this, _, _, cx| this.set_algorithm(a2, cx)))
            })).into_any_element()));
        if self.kind == "anomaly" || self.kind == "forecast" {
            let tc = self.time_column.clone();
            form = form.child(row("Time column", self.column_chips(TIME, &|n| tc.as_deref() == Some(n), "time", |t, c, cx| t.set_time(c, cx), cx)))
                .child(row("Grain", h_flex().gap_1().children(GRAINS.iter().map(|g| { let g2: &'static str = g; ui::chip(SharedString::from(format!("grain-{g}")), *g, self.grain == *g, cx).on_click(cx.listener(move |this, _, _, cx| this.set_grain(g2, cx))) })).into_any_element()));
        }
        let sel = self.columns.clone();
        form = form.child(row(match self.kind { "anomaly" => "Metrics", "forecast" => "Metric", _ => "Features" }, self.column_chips(NUMERIC, &|n| sel.contains(n), "col", |t, c, cx| t.toggle_column(c, cx), cx)));
        if self.kind == "outlier" || self.kind == "cluster" {
            let (idc, gb) = (self.id_column.clone(), self.group_by.clone());
            form = form.child(row("Record identifier", self.column_chips(&[], &|n| idc.as_deref() == Some(n), "idc", |t, c, cx| { let same = t.id_column.as_deref() == Some(c.as_str()); t.set_id(if same { None } else { Some(c) }, cx) }, cx)));
            if self.kind == "outlier" { form = form.child(row("Compare within", self.column_chips(&[], &|n| gb.as_deref() == Some(n), "grp", |t, c, cx| { let same = t.group_by.as_deref() == Some(c.as_str()); t.set_group(if same { None } else { Some(c) }, cx) }, cx))); }
        }
        let shown: &[&str] = match self.kind {
            "anomaly" => &["key", "label", "period", "window", "threshold", "min_history", "recent_points"],
            "forecast" => &["key", "label", "period", "horizon", "backtest_origins", "min_history", "above", "below"],
            "outlier" => &["key", "label", "threshold", "min_samples", "top_n"],
            _ => &["key", "label", "k", "seed"],
        };
        for (k, input) in &self.inputs {
            if !shown.contains(k) { continue; }
            let label = PARAMS.iter().find(|x| x.0 == *k).map(|x| x.1).unwrap_or(k);
            form = form.child(row(label, Input::new(input).into_any_element()));
        }
        form = form.child(h_flex().gap_2()
            .child(Button::new("an-validate").label("Validate").loading(self.busy && self.check.is_none()).disabled(self.query_id.is_none()).on_click(cx.listener(|this, _, _, cx| this.validate(cx))))
            .child(Button::new("an-add").primary().label("Add to saved query").loading(self.busy).disabled(self.query_id.is_none() || !self.check.as_ref().is_some_and(|c| c.ok)).on_click(cx.listener(|this, _, _, cx| this.add(cx))))
            .child(ui::muted("Validate first; adding creates a new version.", cx)));
        if let Some(c) = &self.check {
            form = form.child(if c.ok { ui::note(Tone::Good, "The configuration fits the query output.", cx) }
                else { ui::note(Tone::Bad, c.issues.iter().filter_map(|i| i.get("message").and_then(Value::as_str)).collect::<Vec<_>>().join(" "), cx) });
        }
        if let Some(n) = &self.notice { form = form.child(ui::note(n.0, n.1.clone(), cx)); }
        if let Some(e) = &self.error { form = form.child(ui::error_state(e, cx)); }
        col = col.child(ui::section("analysis-builder", "Add an analysis", Some("Deterministic, offline algorithms. Sensitive or redacted columns cannot be inputs.".into()), form, cx))
            .child(div().text_xs().text_color(p.muted).font_weight(FontWeight::NORMAL).child("Methods: robust rolling baseline (median and MAD), robust seasonal decomposition, naive / seasonal-naive / drift / Holt forecasts with rolling-origin backtests, robust standardized distance, k-means with seeded k-means++."));
        col
    }
}
