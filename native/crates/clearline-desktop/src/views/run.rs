//! One analytics run: its phases (query, analyses, delivery) and timings, the insights it
//! produced with their evidence, charts of anomaly and forecast results, outlier and cluster
//! tables, delivery attempts (with retry), and a page of the result. Everything is fetched from
//! the server, which re-authorizes it for this token (withholding or re-masking data where this
//! role's access is narrower than the run identity's). While the run is still in progress the
//! view refreshes itself.

use crate::app::Ctx;
use crate::chart::{self, Point, Series};
use crate::data::{spawn_fetch, Resource};
use crate::grid::{self, GridColumn, GridDelegate};
use crate::ui::{self, pal, Tone};
use clearline_client::format::when;
use clearline_client::types::{AnalysisRun, RunDetail, RunResultPage};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, FontWeight, ScrollHandle, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputState}, table::TableState, v_flex, Disableable, Sizable};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;

pub struct RunView {
    c: Ctx,
    pub id: String,
    pub detail: Resource<RunDetail>,
    page: Resource<RunResultPage>,
    grid: Entity<TableState<GridDelegate>>,
    names: Vec<(String, String, Entity<InputState>)>,
    names_for: Option<String>,
    pub notice: Option<(Tone, String)>,
    pub error: Option<ApiError>,
    action: bool,
    pub all_insights: bool,
    scroll: ScrollHandle,
    task: Option<Task<()>>,
    poll: Option<Task<()>>,
}

const ACTIVE: &[&str] = &["queued", "running", "delivering"];

impl RunView {
    pub fn new(c: Ctx, id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let grid = grid::new_grid(window, cx);
        let mut v = RunView { c, id, detail: Resource::default(), page: Resource::default(), grid, names: vec![], names_for: None, notice: None, error: None, action: false, all_insights: false, scroll: ScrollHandle::new(), task: None, poll: None };
        v.reload(cx);
        v
    }

    pub fn open(&mut self, id: String, cx: &mut Context<Self>) {
        if id != self.id { self.id = id; self.names_for = None; self.notice = None; self.error = None; grid::set_grid(&self.grid, vec![], Arc::new(vec![]), cx); }
        self.reload(cx);
    }

    pub fn busy(&self) -> bool { self.detail.busy() || self.page.busy() || self.action }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        let shell = self.c.shell.clone();
        self.detail.state = crate::data::Load::Loading;
        self.task = Some(spawn_fetch(cx, shell, move || cl.run(&t, &id), |this: &mut Self, r, cx| {
            match r {
                Ok(d) => {
                    let active = ACTIVE.contains(&d.run.status.as_str());
                    let has_data = d.access.data && d.run.query_status == "succeeded";
                    this.detail.state = crate::data::Load::Ready(d);
                    if has_data { this.load_page(cx); }
                    // Keep following a run that is still in progress.
                    if active {
                        this.poll = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor().timer(Duration::from_millis(1000)).await;
                            let _ = this.update(cx, |v, cx| v.reload(cx));
                        }));
                    } else { this.poll = None; }
                }
                Err(e) => this.detail.state = crate::data::Load::Failed(e),
            }
        }));
        cx.notify();
    }

    fn load_page(&mut self, cx: &mut Context<Self>) {
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        self.page.load(cx, self.c.shell.clone(), |v| &mut v.page, move || cl.run_result(&t, &id, 0, 1000));
    }

    fn action<T: Send + 'static>(&mut self, cx: &mut Context<Self>, f: impl FnOnce() -> clearline_client::Result<T> + Send + 'static, done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static) {
        if self.action { return; }
        self.action = true; self.error = None; self.notice = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), f, move |this: &mut Self, r, cx| {
            this.action = false;
            match r { Ok(v) => done(this, v, cx), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    pub fn retry(&mut self, cx: &mut Context<Self>) {
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        self.action(cx, move || cl.retry_deliveries(&t, &id), |this, v, cx| {
            let n = v.get("retried").and_then(Value::as_array).map(|a| a.len()).unwrap_or(0);
            this.notice = Some((Tone::Good, format!("{n} deliver{} queued for retry; the query is not re-run. Access is re-checked before sending.", if n == 1 { "y" } else { "ies" })));
            this.reload(cx);
        });
    }

    pub fn rerun(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (cl, t, id) = (self.c.client(), self.c.tenant(), self.id.clone());
        let _ = window;
        self.action(cx, move || cl.rerun(&t, &id), |this, q, cx| { this.notice = Some((Tone::Good, format!("New run {} queued.", &q.run_id[..8]))); this.open(q.run_id, cx); });
    }

    pub fn save_names(&mut self, cx: &mut Context<Self>) {
        let Some(analysis) = self.names.first().map(|n| n.0.clone()) else { return };
        let mut m = Map::new();
        for (_, cluster, input) in &self.names { let v = input.read(cx).value().trim().to_string(); if !v.is_empty() { m.insert(cluster.clone(), json!(v)); } }
        let (cl, t, names) = (self.c.client(), self.c.tenant(), Value::Object(m));
        self.action(cx, move || cl.review_clusters(&t, &analysis, &names), |this, _, cx| { this.notice = Some((Tone::Good, "Cluster names saved (reviewed by you).".into())); this.reload(cx); });
    }

    pub fn set_cluster_name(&mut self, cluster: &str, name: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((_, _, i)) = self.names.iter().find(|n| n.1 == cluster) else { return false };
        i.update(cx, |s, cx| s.set_value(name.to_string(), window, cx));
        true
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(p) = self.page.ready() {
            if self.grid.read(cx).delegate().rows.len() != p.rows.len() || self.grid.read(cx).delegate().cols.len() != p.columns.len() {
                let cols = p.columns.iter().map(|c| GridColumn { name: c.name.clone(), masked: c.masked.clone(), numeric: grid::is_numeric_type(&c.ty) }).collect();
                let rows = Arc::new(p.rows.clone());
                grid::set_grid(&self.grid, cols, rows, cx);
            }
        }
        let Some(d) = self.detail.ready() else { return };
        let Some(a) = d.analyses.iter().find(|a| a.ty == "cluster" && a.status == "succeeded" && !a.withheld) else { return };
        if self.names_for.as_deref() == Some(a.id.as_str()) { return; }
        let reviewed = a.review.get("names").cloned().unwrap_or(json!({}));
        let clusters = a.result.get("clusters").and_then(Value::as_array).cloned().unwrap_or_default();
        let aid = a.id.clone();
        self.names = clusters.iter().map(|c| {
            let n = c.get("cluster").and_then(Value::as_i64).unwrap_or(0).to_string();
            let cur = reviewed.get(&n).and_then(Value::as_str).unwrap_or("").to_string();
            let input = cx.new(|cx| { let mut s = InputState::new(window, cx).placeholder(format!("Name for cluster {n}")); s.set_value(cur, window, cx); s });
            (aid.clone(), n, input)
        }).collect();
        self.names_for = Some(a.id.clone());
    }

    /// Scroll the page to `y` pixels from the top (automation: screenshots of lower sections).
    pub fn scroll_to(&mut self, y: f32, cx: &mut Context<Self>) { self.scroll.set_offset(gpui::point(px(0.), px(-y))); cx.notify(); }
    pub fn show_all_insights(&mut self, on: bool, cx: &mut Context<Self>) { self.all_insights = on; cx.notify(); }

    pub fn snapshot(&self, cx: &App) -> Value {
        let g = self.grid.read(cx).delegate();
        json!({ "view": "run", "id": self.id,
            "detail": self.detail.ready().map(|d| json!({ "status": d.run.status, "query_status": d.run.query_status, "analysis_status": d.run.analysis_status, "delivery_status": d.run.delivery_status,
                "failure_class": d.run.failure_class, "error_code": d.run.error_code, "error_message": d.run.error_message, "trigger": d.run.trigger, "version": d.run.query_version,
                "run_as": d.run.run_as, "access": d.access, "timings": d.run.timings, "query": d.query.name,
                "insights": d.insights.iter().map(|i| json!({ "kind": i.kind, "severity": i.severity, "title": i.title, "body": i.body, "narrative": i.narrative })).collect::<Vec<_>>(),
                "analyses": d.analyses.iter().map(|a| json!({ "key": a.key, "type": a.ty, "algorithm": a.algorithm, "version": a.algorithm_version, "status": a.status, "message": a.message, "withheld": a.withheld,
                    "charts": charts_of(a).len(), "review": a.review })).collect::<Vec<_>>(),
                "deliveries": d.deliveries.iter().map(|x| json!({ "destination": x.destination, "kind": x.kind, "status": x.status, "attempts": x.attempts, "last_error_code": x.last_error_code })).collect::<Vec<_>>() })),
            "result": self.page.ready().map(|p| json!({ "columns": p.columns, "row_count": p.row_count, "grid_rows": g.rows.len(), "displayed": g.displayed(3) })),
            "error": self.error.as_ref().or(self.detail.state.error()).map(|e| json!({ "code": e.code(), "message": e.user_message() })),
            "notice": self.notice.as_ref().map(|n| n.1.clone()), "polling": self.poll.is_some() })
    }

    fn analysis_block(&self, a: &AnalysisRun, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let mut b = v_flex().gap_2().p_3().border_1().border_color(p.rule).rounded(px(4.))
            .child(h_flex().gap_2().items_center().child(div().font_weight(FontWeight::SEMIBOLD).child(a.config.get("label").and_then(Value::as_str).unwrap_or(&a.key).to_string()))
                .child(ui::tag(format!("{} v{}", a.algorithm, a.algorithm_version), cx)).child(ui::run_signal(if a.status == "succeeded" { "succeeded" } else { a.status.as_str() }, cx))
                .child(ui::muted(format!("{} input rows · prepare {} ms · algorithm {} ms", a.input_rows.unwrap_or(0), a.timings.get("prepare_ms").and_then(Value::as_f64).unwrap_or(0.0), a.timings.get("algorithm_ms").and_then(Value::as_f64).unwrap_or(0.0)), cx)));
        if let Some(m) = &a.message { b = b.child(ui::note(if a.status == "succeeded" { Tone::Idle } else { Tone::Warn }, m.clone(), cx)); }
        if a.withheld { return b.child(ui::note(Tone::Warn, "Result withheld: it was computed over a column that is redacted for your role now.", cx)).into_any_element(); }
        for (i, s) in charts_of(a).iter().enumerate() { b = b.child(chart::chart(&format!("chart-{}-{i}", a.key), s, 180.0, cx)); }
        match a.ty.as_str() {
            "forecast" if a.status == "succeeded" => {
                let bt = &a.result["backtest"];
                b = b.child(ui::muted(format!("Method {} · backtest over {} rolling origins: MAE {}, RMSE {}, MAPE {}, MASE {} · interval {} (coverage on the backtest {})",
                    a.result["method"].as_str().unwrap_or(""), bt["origins"], bt["mae"], bt["rmse"], opt(&bt["mape"], "%"), opt(&bt["mase"], ""), opt(&a.result["interval"], ""), opt(&bt["interval_coverage"], "")), cx));
            }
            "outlier" if a.status == "succeeded" => {
                let rows = a.result["records"].as_array().cloned().unwrap_or_default().iter().take(15).map(|r| vec![
                    ui::text(r["rank"].to_string()), ui::text(r["id"].as_str().map(str::to_string).unwrap_or(format!("row {}", r["row"]))), ui::text(r["group"].as_str().unwrap_or("all").to_string()),
                    ui::text(r["score"].to_string()), if r["flagged"].as_bool() == Some(true) { ui::signal(Tone::Warn, "unusual", cx).into_any_element() } else { ui::text("") },
                    ui::text(r["contributions"].as_array().map(|c| c.iter().take(2).map(|x| format!("{} {:.0}%", x["feature"].as_str().unwrap_or(""), x["share"].as_f64().unwrap_or(0.0) * 100.0)).collect::<Vec<_>>().join(", ")).unwrap_or_default())]).collect();
                b = b.child(ui::simple_table(&["Rank", "Record", "Compared within", "Score", "", "Main contributions"], rows, &[0, 3], cx))
                    .child(ui::muted(format!("{} of {} records reach the threshold. Unusual relative to comparable records is not the same as wrong.", a.result["flagged"], a.result["scored"]), cx));
            }
            "cluster" if a.status == "succeeded" => {
                let feats: Vec<String> = a.result["features"].as_array().map(|f| f.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                let names = &a.review["names"];
                let rows = a.result["clusters"].as_array().cloned().unwrap_or_default().iter().map(|c| {
                    let n = c["cluster"].to_string();
                    let mut r = vec![ui::text(names.get(&n).and_then(Value::as_str).map(|s| format!("{s} (reviewed)")).unwrap_or(c["label"].as_str().unwrap_or("").to_string())), ui::text(c["size"].to_string())];
                    for f in &feats { r.push(ui::text(c["centroid"][f].to_string())); }
                    r
                }).collect();
                let mut head: Vec<&str> = vec!["Cluster", "Size"];
                for f in &feats { head.push(f.as_str()); }
                b = b.child(ui::simple_table(&head, rows, &[1], cx))
                    .child(ui::muted(format!("Mean silhouette {} (1 = well separated). {} scaling. Statistical groupings: review and name them before treating them as business segments.", a.result["silhouette"], a.result["scaling"]["method"].as_str().unwrap_or("")), cx));
                if a.id == self.names.first().map(|n| n.0.clone()).unwrap_or_default() && self.c.can("analysis:run") {
                    b = b.child(h_flex().gap_2().flex_wrap().children(self.names.iter().map(|(_, _, i)| div().w(px(180.)).child(Input::new(i)))).child(Button::new("save-names").label("Save names").on_click(cx.listener(|this, _, _, cx| this.save_names(cx)))));
                }
            }
            _ => {}
        }
        if let Some(l) = a.result.get("limitations").and_then(Value::as_array) {
            b = b.child(v_flex().children(l.iter().filter_map(Value::as_str).map(|s| ui::muted(format!("Limitation: {s}"), cx))));
        }
        b.into_any_element()
    }
}

fn opt(v: &Value, suffix: &str) -> String { if v.is_null() { "n/a".into() } else { format!("{}{suffix}", v) } }

fn num(v: &Value) -> Option<f64> { v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())) }

/// Chart series for an analysis result (anomaly per metric; forecast history + forecast).
pub fn charts_of(a: &AnalysisRun) -> Vec<Series> {
    if a.status != "succeeded" || a.withheld { return vec![]; }
    match a.ty.as_str() {
        "anomaly" => a.result["metrics"].as_array().cloned().unwrap_or_default().iter().map(|m| {
            let marks: Map<String, Value> = m["anomalies"].as_array().cloned().unwrap_or_default().iter().map(|x| (x["t"].as_str().unwrap_or("").to_string(), x["severity"].clone())).collect();
            Series { title: format!("{}: observed (line), expected range (band), anomalies (dots)", m["metric"].as_str().unwrap_or("")),
                points: m["points"].as_array().cloned().unwrap_or_default().iter().map(|p| {
                    let t = p["t"].as_str().unwrap_or("").to_string();
                    let marker = marks.get(&t).map(|s| if s.as_str() == Some("high") { "high" } else { "other" });
                    Point { label: t, observed: num(&p["observed"]), lower: num(&p["lower"]), upper: num(&p["upper"]), expected: num(&p["expected"]), forecast: None, marker }
                }).collect() }
        }).collect(),
        "forecast" => {
            let mut pts: Vec<Point> = a.result["history"].as_array().cloned().unwrap_or_default().iter().map(|h| Point { label: h["t"].as_str().unwrap_or("").into(), observed: num(&h["value"]), ..Default::default() }).collect();
            if let Some(last) = pts.last_mut() { last.forecast = last.observed; }
            pts.extend(a.result["forecast"].as_array().cloned().unwrap_or_default().iter().map(|f| Point { label: f["t"].as_str().unwrap_or("").into(), forecast: num(&f["value"]), lower: num(&f["lower"]), upper: num(&f["upper"]), ..Default::default() }));
            vec![Series { title: format!("{}: history and forecast (interval band)", a.config["metric"].as_str().unwrap_or("")), points: pts }]
        }
        _ => vec![],
    }
}

impl Render for RunView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        self.sync(window, cx);
        let mut body = v_flex().w_full().gap_3();
        if let Some(e) = self.detail.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(d) = self.detail.ready().cloned() {
            let r = &d.run;
            let qid = d.query.id.clone();
            body = body.child(ui::page_head(format!("Run of \u{201c}{}\u{201d}", d.query.name), Some(ui::muted(format!("{} run {} · version {} · ran as {} ({}) · {}{}", r.trigger, &r.id[..8], r.query_version, r.run_as.actor, r.run_as.role,
                    when(r.created_at.as_deref()), r.occurrence_at.as_ref().map(|o| format!(" · scheduled for {}", when(Some(o)))).unwrap_or_default()), cx).into_any_element()),
                Some(h_flex().gap_2()
                    .child(Button::new("run-open-query").label("Open saved query").on_click(cx.listener(move |this, _, window, cx| {
                        let (shell, id) = (this.c.shell.clone(), qid.clone());
                        let _ = shell.update(cx, |s, cx| s.open_saved_query(id, window, cx));
                    })))
                    .child(Button::new("run-rerun").label("Rerun").disabled(self.action || !self.c.can("analysis:run")).on_click(cx.listener(|this, _, window, cx| this.rerun(window, cx))))
                    .child(Button::new("run-refresh").primary().label("Refresh").loading(self.detail.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx)))).into_any_element()), cx));
            body = body.child(h_flex().gap_2().flex_wrap().child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Outcome")).child(ui::run_signal(&r.status, cx))
                .child(ui::muted("query", cx)).child(ui::run_signal(&r.query_status, cx)).child(ui::muted("analyses", cx)).child(ui::run_signal(&r.analysis_status, cx))
                .child(ui::muted("delivery", cx)).child(ui::run_signal(&r.delivery_status, cx)).children(r.failure_class.as_ref().map(|f| ui::tag(format!("failure: {f}"), cx)))
                .child(ui::muted(format!("attempt {} of {}", r.attempt, r.max_attempts), cx)));
            if let Some(m) = &r.error_message { body = body.child(ui::note(if r.status == "succeeded" { Tone::Idle } else { Tone::Bad }, m.clone(), cx)); }
            if r.missed_occurrences > 0 { body = body.child(ui::note(Tone::Warn, format!("{} earlier occurrence(s) were missed while the scheduler was not running; only the latest ran.", r.missed_occurrences), cx)); }
            let t = &r.timings;
            let ms = |k: &str| t.get(k).and_then(Value::as_f64).map(|v| format!("{v:.0} ms")).unwrap_or("–".into());
            body = body.child(h_flex().gap_6().flex_wrap().child(ui::fact("Queue wait", div().child(ms("queue_wait_ms")), cx)).child(ui::fact("Identity check", div().child(ms("identity_ms")), cx))
                .child(ui::fact("Query", div().child(ms("query_ms")), cx)).child(ui::fact("Snapshot", div().child(ms("snapshot_ms")), cx)).child(ui::fact("Analyses", div().child(ms("analysis_ms")), cx))
                .child(ui::fact("Delivery", div().child(ms("delivery_ms")), cx))
                .children(r.result.as_ref().map(|res| ui::fact("Rows", div().child(format!("{}{}", res.row_count.unwrap_or(0), if res.truncated == Some(true) { " (truncated)" } else { "" })), cx))));
            if let Some(n) = &self.notice { body = body.child(ui::note(n.0, n.1.clone(), cx)); }
            if let Some(e) = &self.error { body = body.child(ui::error_state(e, cx)); }
            if !d.access.data { if let Some(reason) = &d.access.reason { body = body.child(ui::note(Tone::Idle, reason.clone(), cx)); } }
            if !d.access.remasked_columns.is_empty() { body = body.child(ui::note(Tone::Warn, format!("Redacted for your role now: {}. Values and dependent insights are shown redacted or withheld.", d.access.remasked_columns.join(", ")), cx)); }

            // Insights first: what changed or was predicted, with the method and its evidence.
            if !d.insights.is_empty() || d.insights_withheld > 0 {
                let mut ins = v_flex().gap_2();
                const FIRST: usize = 3;
                let shown = if self.all_insights { d.insights.len() } else { d.insights.len().min(FIRST) };
                for i in &d.insights[..shown] {
                    let mut card = v_flex().gap_1().p_3().rounded(px(4.)).border_1().border_color(p.rule).border_l_4()
                        .border_color(match i.severity.as_str() { "high" => p.bad_ink, "medium" | "low" => p.warn_ink, _ => p.rule_strong })
                        .child(h_flex().gap_2().items_center().child(ui::severity(&i.severity, cx)).child(ui::tag(i.kind.clone(), cx)).child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(i.title.clone())))
                        .child(div().text_sm().child(i.body.clone()));
                    if let Some(n) = &i.narrative { if let Some(text) = &n.text { card = card.child(ui::muted(format!("Model-written summary ({}, checked against the computed values): {text}", n.model.clone().unwrap_or(n.provider.clone())), cx)); } }
                    ins = ins.child(card);
                }
                if d.insights_withheld > 0 { ins = ins.child(ui::muted(format!("{} insight(s) withheld for your role.", d.insights_withheld), cx)); }
                if d.insights.len() > FIRST {
                    let label = if self.all_insights { "Show the first three".to_string() } else { format!("Show all {} insights", d.insights.len()) };
                    ins = ins.child(h_flex().child(Button::new("run-insights-all").small().label(label).on_click(cx.listener(|this, _, _, cx| { this.all_insights = !this.all_insights; cx.notify(); }))));
                }
                body = body.child(ui::section("insights", "Insights", Some("Computed by the listed methods from this run's authorized result. Statistical findings, not explanations of their causes.".into()), ins, cx));
            }
            if !d.analyses.is_empty() {
                let blocks: Vec<AnyElement> = d.analyses.iter().map(|a| self.analysis_block(a, cx)).collect();
                body = body.child(ui::section("analyses", "Analyses", None, v_flex().gap_3().children(blocks), cx));
            }
            let can_retry = d.deliveries.iter().any(|x| x.status == "failed" || x.status == "blocked") && self.c.can("schedule:manage");
            let rows = d.deliveries.iter().map(|x| vec![ui::text(x.destination.clone()), ui::text(x.kind.replace('_', "-")), ui::run_signal(&x.status, cx).into_any_element(),
                ui::text(format!("{} of {}", x.attempts, x.max_attempts)), ui::muted(x.last_error.clone().unwrap_or_default(), cx).into_any_element(), ui::text(when(x.delivered_at.as_deref().or(x.next_attempt_at.as_deref())))]).collect();
            body = body.child(ui::section("deliveries", "Deliveries", Some("Each destination is delivered once per run; failed or blocked deliveries can be retried without re-running the query.".into()),
                v_flex().gap_2().child(if d.deliveries.is_empty() { ui::empty("No destinations for this run.", cx).into_any_element() } else { ui::simple_table_weighted(&["Destination", "Kind", "Status", "Attempts", "Last error", "When"], rows, &[], &[1.2, 0.7, 0.8, 0.7, 2.2, 1.1], cx).into_any_element() })
                    .children(can_retry.then(|| h_flex().child(Button::new("retry-deliveries").label("Retry failed deliveries").disabled(self.action).on_click(cx.listener(|this, _, _, cx| this.retry(cx))))))
                , cx));
            if let Some(pg) = self.page.ready() {
                body = body.child(ui::section("result", "Result", Some(format!("{} rows{} (the run's bounded snapshot, as your role may see it now).", pg.row_count, if pg.truncated { ", truncated" } else { "" }).into()),
                    div().h(px(320.)).child(grid::grid_element(&self.grid)), cx));
            } else if let Some(e) = self.page.state.error() { body = body.child(ui::error_state(e, cx)); }
        } else if self.detail.busy() { body = body.child(ui::loading("Loading run…", cx)); }
        div().id("run").size_full().overflow_y_scroll().track_scroll(&self.scroll).p_8().child(body)
    }
}
