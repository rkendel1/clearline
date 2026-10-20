//! Query workspace: ask in plain English, inspect the SQL proposal, edit it, and
//! run it only by explicit action. Every proposal and every execution is
//! validated and authorized by the server; this view shows its decisions.
//! Generation, validation and execution run in the background, so the editors
//! stay responsive and a running query can be cancelled.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::grid::{self, GridColumn, GridDelegate};
use crate::perf;
use crate::ui::{self, pal, Tone};
use clearline_client::types::{Catalog, ExecuteResult, Proposal};
use clearline_client::{new_execution_id, ApiError};
use gpui::{div, prelude::*, px, AnyElement, App, ClipboardItem, Context, Entity, FontWeight, ScrollHandle, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputEvent, InputState}, table::TableState, v_flex, Disableable};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Instant;

pub const EXAMPLES: &[&str] = &[
    "Show the total paid amount by tenant for the last month.",
    "Find claims that reference members who have not arrived.",
    "Show me batches with reconciliation failures.",
    "Compare paid amounts across the last three reporting periods.",
    "List claims with amounts above $2,000, excluding sensitive member information.",
];

const SECTION_PROPOSAL: usize = 3;
const SECTION_RESULTS: usize = 4;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Phase { Idle, Generating, Validating, Running }

pub struct QueryView {
    c: Ctx,
    pub question: Entity<InputState>,
    pub sql: Entity<InputState>,
    catalog: Resource<Catalog>,
    pub proposal: Option<Proposal>,
    pub result: Option<ExecuteResult>,
    pub grid: Entity<TableState<GridDelegate>>,
    pub phase: Phase,
    running_execution: Option<String>,
    error: Option<ApiError>,
    pub notice: Option<(Tone, String)>,
    show_validated: bool,
    task: Option<Task<()>>,
    /// Text in the SQL editor when the current proposal was loaded; editing it marks the proposal stale.
    loaded_sql: String,
    pub sql_dirty: bool,
    /// Results arrive in background callbacks, which have no Window; editor updates are applied on the next render.
    pending_proposal: Option<Proposal>,
    applied_at: Option<(Instant, i64)>,
    scroll: ScrollHandle,
    scroll_to: Option<usize>,
}

impl QueryView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let question = cx.new(|cx| InputState::new(window, cx).multi_line(true).auto_grow(2, 5).placeholder("Describe the information you need, e.g. \"Show me batches with reconciliation failures.\""));
        let sql = cx.new(|cx| InputState::new(window, cx).code_editor("sql").line_number(true).placeholder("SELECT … (or generate a proposal above)"));
        cx.subscribe_in(&question, window, |this, _, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { secondary: true } = ev { this.generate(window, cx); }
        }).detach();
        cx.subscribe_in(&sql, window, |this, s, ev: &InputEvent, _, cx| {
            if let InputEvent::Change = ev {
                let dirty = s.read(cx).value().as_ref() != this.loaded_sql;
                if dirty != this.sql_dirty { this.sql_dirty = dirty; cx.notify(); }
            }
        }).detach();
        let grid = grid::new_grid(window, cx);
        let mut v = QueryView { c, question, sql, catalog: Resource::default(), proposal: None, result: None, grid, phase: Phase::Idle, running_execution: None,
            error: None, notice: None, show_validated: false, task: None, loaded_sql: String::new(), sql_dirty: false, pending_proposal: None, applied_at: None, scroll: ScrollHandle::new(), scroll_to: None };
        v.load_catalog(cx);
        v
    }

    fn load_catalog(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.catalog.load(cx, self.c.shell.clone(), |v| &mut v.catalog, move || cl.catalog(&t));
    }

    pub fn busy(&self) -> bool { self.phase != Phase::Idle || self.catalog.busy() }

    /// A field policy changed: results computed under the old policy are discarded and re-run on request.
    pub fn policy_changed(&mut self, cx: &mut Context<Self>) {
        if self.result.take().is_some() {
            grid::set_grid(&self.grid, vec![], Arc::new(vec![]), cx);
            self.notice = Some((Tone::Warn, "Field policies changed. Results computed under the previous policy were cleared; run the query again.".into()));
        }
        self.load_catalog(cx);
        cx.notify();
    }

    fn set_proposal(&mut self, p: Proposal, window: &mut Window, cx: &mut Context<Self>) {
        let sql = p.proposed_sql.clone().unwrap_or_default();
        self.loaded_sql = sql.clone();
        self.sql_dirty = false;
        self.sql.update(cx, |s, cx| s.set_value(sql, window, cx));
        self.proposal = Some(p);
    }

    pub fn set_question(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.question.update(cx, |q, cx| q.set_value(text.to_string(), window, cx));
    }

    pub fn set_sql(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.sql.update(cx, |q, cx| q.set_value(text.to_string(), window, cx));
        self.sql_dirty = self.sql.read(cx).value().as_ref() != self.loaded_sql;
    }

    /// Open SQL from history as an edited proposal of `parent`.
    pub fn load_sql(&mut self, sql: String, parent: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.set_sql(&sql, window, cx);
        self.validate_with_parent(parent, window, cx);
    }

    pub fn generate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let q = self.question.read(cx).value().trim().to_string();
        if q.is_empty() || self.phase != Phase::Idle { return; }
        self.phase = Phase::Generating;
        self.error = None;
        self.notice = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        let _ = window;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.propose_question(&t, &q), |this: &mut Self, r, cx| {
            this.phase = Phase::Idle;
            match r {
                Ok(p) => { this.pending_proposal = Some(p); cx.notify(); }
                Err(e) => this.error = Some(e),
            }
        }));
        cx.notify();
    }

    /// Validate the SQL currently in the editor as a new proposal (edited from the current one, if any).
    pub fn validate(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let parent = self.proposal.as_ref().map(|p| p.id.clone());
        self.validate_with_parent(parent, window, cx);
    }

    fn validate_with_parent(&mut self, parent: Option<String>, _window: &mut Window, cx: &mut Context<Self>) {
        let sql = self.sql.read(cx).value().to_string();
        if sql.trim().is_empty() || self.phase != Phase::Idle { return; }
        self.phase = Phase::Validating;
        self.error = None;
        self.notice = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.propose_sql(&t, &sql, parent.as_deref()), |this: &mut Self, r, _| {
            this.phase = Phase::Idle;
            match r { Ok(p) => this.pending_proposal = Some(p), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    /// Explicit execution. The server re-validates the stored proposal under the current policy.
    pub fn execute(&mut self, mode: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = &self.proposal else { return };
        if !p.executable || self.sql_dirty || self.phase != Phase::Idle { return; }
        let id = p.id.clone();
        let exec_id = new_execution_id();
        self.running_execution = Some(exec_id.clone());
        self.phase = Phase::Running;
        self.error = None;
        self.notice = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        let started = Instant::now();
        let _ = window;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.execute(&t, &id, mode, Some(&exec_id)), move |this: &mut Self, r, cx| {
            this.phase = Phase::Idle;
            this.running_execution = None;
            match r {
                Ok(res) => {
                    let cols = res.columns.iter().map(|c| GridColumn { name: c.name.clone(), masked: c.masked.clone(), numeric: grid::is_numeric_type(&c.ty) }).collect();
                    let rows = Arc::new(res.rows.clone());
                    grid::set_grid(&this.grid, cols, rows, cx);
                    if this.catalog.ready().is_some_and(|c| c.policy_epoch != res.policy_epoch) { this.load_catalog(cx); }
                    this.applied_at = Some((started, res.row_count));
                    this.scroll_to = Some(SECTION_RESULTS);
                    this.result = Some(res);
                }
                Err(e) => this.error = Some(e),
            }
        }));
        cx.notify();
    }

    pub fn cancel(&mut self, cx: &mut Context<Self>) {
        let Some(exec) = self.running_execution.clone() else { return };
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.notice = Some((Tone::Idle, "Cancelling…".into()));
        // Fire-and-forget: the execution request itself reports the cancelled status.
        cx.background_executor().spawn(async move { let _ = cl.cancel(&t, &exec); }).detach();
        cx.notify();
    }

    pub fn export(&mut self, cx: &mut Context<Self>) {
        let Some(p) = &self.proposal else { return };
        if !p.executable || self.sql_dirty { return; }
        let (cl, t, id) = (self.c.client(), self.c.tenant(), p.id.clone());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.export_csv(&t, &id), |this: &mut Self, r, cx| match r {
            Ok(csv) => {
                let path = std::env::temp_dir().join(format!("clearline-query-{}.csv", this.proposal.as_ref().map(|p| p.id.clone()).unwrap_or_default()));
                match std::fs::write(&path, csv.as_bytes()) {
                    Ok(_) => { cx.write_to_clipboard(ClipboardItem::new_string(path.display().to_string())); this.notice = Some((Tone::Good, format!("Exported {} lines (redacted by the server) to {}; the path is on the clipboard.", csv.lines().count().saturating_sub(1), path.display()))); }
                    Err(e) => this.notice = Some((Tone::Bad, format!("Could not write the export: {e}"))),
                }
            }
            Err(e) => this.error = Some(e),
        }));
    }

    /// Copy the selected result row (or the header and first row) as tab-separated text. The values
    /// are the ones the server returned, so redacted columns are copied redacted.
    pub fn copy_row(&mut self, cx: &mut Context<Self>) -> Option<String> {
        let g = self.grid.read(cx);
        let d = g.delegate();
        let ix = g.selected_row().unwrap_or(0);
        let row = d.row_at(ix)?;
        let text = format!("{}\n{}", d.cols.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join("\t"), row.iter().map(clearline_client::format::cell).collect::<Vec<_>>().join("\t"));
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        self.notice = Some((Tone::Good, "Row copied to the clipboard.".into()));
        cx.notify();
        Some(text)
    }

    pub fn snapshot(&self, cx: &App) -> Value {
        let g = self.grid.read(cx).delegate();
        json!({
            "view": "query",
            "phase": format!("{:?}", self.phase),
            "question": self.question.read(cx).value().to_string(),
            "sql_editor": self.sql.read(cx).value().to_string(),
            "sql_dirty": self.sql_dirty,
            "catalog": self.catalog.ready().map(|c| json!({ "provider": c.provider.id, "policy_epoch": c.policy_epoch,
                "tables": c.tables.iter().map(|t| json!({ "name": t.name, "columns": t.columns.iter().map(|c| json!([c.name, c.access])).collect::<Vec<_>>() })).collect::<Vec<_>>() })),
            "proposal": self.proposal.as_ref().map(|p| json!({ "id": p.id, "source": p.source, "parent_id": p.parent_id, "proposed_sql": p.proposed_sql, "validated_sql": p.validated_sql,
                "executable": p.executable, "executed": p.executed, "ok": p.validation.ok, "issues": p.validation.issues, "summary": p.validation.summary,
                "tables": p.validation.tables, "output": p.validation.output, "model_explanation": p.model_explanation })),
            "result": self.result.as_ref().map(|r| json!({ "execution_id": r.execution_id, "status": r.status, "row_count": r.row_count, "truncated": r.truncated, "duration_ms": r.duration_ms,
                "columns": r.columns, "error": r.error, "grid_rows": g.rows.len(), "displayed": g.displayed(5) })),
            "error": self.error.as_ref().map(|e| json!({ "code": e.code(), "message": e.user_message() })),
            "notice": self.notice.as_ref().map(|n| n.1.clone()),
        })
    }

    // ------------------------------------------------------------------ rendering

    fn catalog_panel(&self, cx: &App) -> AnyElement {
        let p = pal(cx);
        let body: AnyElement = match &self.catalog.state {
            crate::data::Load::Ready(c) => v_flex().gap_3()
                .child(ui::muted(format!("Provider: {}{} · policy epoch {}", c.provider.id, c.provider.model.as_ref().map(|m| format!(" ({m})")).unwrap_or_default(), c.policy_epoch), cx))
                .children(c.tables.iter().map(|t| v_flex().gap_1()
                    .child(h_flex().gap_2().child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child(t.name.clone())).child(ui::muted(t.kind.clone(), cx)))
                    .children(t.columns.iter().map(|col| h_flex().justify_between().gap_2()
                        .child(div().text_xs().font_family("DejaVu Sans Mono").text_color(if col.access == "full" { p.ink } else { p.ink2 }).child(col.name.clone()))
                        .child(h_flex().gap_1().child(div().text_xs().text_color(p.muted).child(col.ty.clone())).children((col.access != "full").then(|| ui::access_badge(&col.access, cx))))))))
                .into_any_element(),
            crate::data::Load::Failed(e) => ui::error_state(e, cx).into_any_element(),
            _ => ui::loading("Loading the catalog…", cx).into_any_element(),
        };
        v_flex().id("catalog").w(px(330.)).flex_none().h_full().overflow_y_scroll().p_4().gap_3().bg(p.surface).border_l_1().border_color(p.rule)
            .child(div().font_weight(FontWeight::BOLD).child("What you can query"))
            .child(ui::muted("Only tables and columns your role may discover are listed, and only these are ever described to the model provider.", cx))
            .child(body).into_any_element()
    }

    fn proposal_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let prop = self.proposal.as_ref();
        let can_run = prop.is_some_and(|p| p.executable) && !self.sql_dirty && self.phase == Phase::Idle;
        let running = self.phase == Phase::Running;
        let mut panel = v_flex().gap_3();
        // Header and SQL editor.
        panel = panel.child(v_flex().gap_1()
            .child(h_flex().gap_2().items_center().child(div().font_weight(FontWeight::BOLD).child("SQL proposal"))
                .children(prop.map(|p| ui::tag(format!("{} · {}", p.source, &p.id[..8]), cx)))
                .children(prop.and_then(|p| p.parent_id.as_ref()).map(|pid| ui::muted(format!("edited from {}", &pid[..8]), cx))))
            .child(ui::muted("Generated SQL is an untrusted proposal: it runs only when you choose Preview or Run, after the server validates it.", cx)));
        panel = panel.child(Input::new(&self.sql).h(px(200.)));
        panel = panel.child(h_flex().gap_2()
            .child(Button::new("validate").label(if self.phase == Phase::Validating { "Validating…" } else if self.proposal.is_some() { "Validate edit" } else { "Validate SQL" })
                .loading(self.phase == Phase::Validating).disabled(self.phase != Phase::Idle || (self.proposal.is_some() && !self.sql_dirty))
                .on_click(cx.listener(|this, _, window, cx| this.validate(window, cx))))
            .child(Button::new("preview").label("Preview 20 rows").disabled(!can_run).on_click(cx.listener(|this, _, window, cx| this.execute("preview", window, cx))))
            .child(Button::new("run").primary().label(if running { "Running…" } else { "Run query" }).loading(running).disabled(!can_run)
                .on_click(cx.listener(|this, _, window, cx| this.execute("run", window, cx))))
            .child(Button::new("cancel").danger().label("Cancel").disabled(!running).on_click(cx.listener(|this, _, _, cx| this.cancel(cx))))
            .child(Button::new("export").label("Export CSV").disabled(!can_run).on_click(cx.listener(|this, _, _, cx| this.export(cx)))));
        if self.sql_dirty && self.proposal.is_some() {
            panel = panel.child(ui::note(Tone::Warn, "The SQL was edited. Validate the edit to create a new proposal before running it; the previous validation does not apply to the edited text.", cx));
        }
        let Some(prop) = prop else { return panel.into_any_element() };
        // Validation decision.
        let v = &prop.validation;
        if v.ok {
            panel = panel.child(v_flex().gap_1().child(h_flex().gap_2().child(ui::signal(Tone::Good, "Validated by the server", cx))
                .children(prop.estimate.as_ref().map(|e| ui::muted(format!("Planner estimate: cost {:.0}, about {:.0} rows. Nothing has been executed.", e.cost, e.rows), cx))))
                .children(v.summary.iter().map(|s| div().text_sm().text_color(p.ink).child(format!("• {s}")))));
        } else {
            panel = panel.child(v_flex().gap_1().children(v.issues.iter().map(|i| {
                let tone = if matches!(i.code.as_str(), "restricted_field" | "unknown_column" | "unknown_table" | "cannot_answer") { Tone::Warn } else { Tone::Bad };
                let lead = match i.code.as_str() {
                    "restricted_field" => "Not permitted for your role: ",
                    "unknown_column" | "unknown_table" => "Not available: ",
                    "cannot_answer" => "No proposal: ",
                    _ => "Rejected: ",
                };
                ui::note(tone, format!("{lead}{} ({})", i.message, i.code), cx)
            })));
        }
        if let Some(expl) = &prop.model_explanation {
            panel = panel.child(v_flex().gap_1().child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.ink2).child("Model explanation (unverified; the server's summary above is authoritative)"))
                .child(div().text_sm().text_color(p.ink2).child(expl.clone()))
                .children(prop.assumptions.iter().map(|a| div().text_xs().text_color(p.muted).child(format!("Assumption: {a}")))));
        }
        if !v.columns.is_empty() {
            let rows = v.columns.iter().map(|c| vec![ui::text(format!("{}.{}", c.table, c.column)), ui::access_badge(&c.access, cx).into_any_element(), ui::text(c.usages.join(", "))]).collect();
            panel = panel.child(v_flex().gap_1().child(div().text_xs().font_weight(FontWeight::SEMIBOLD).text_color(p.ink2)
                .child(format!("Referenced: {}{}", v.tables.join(", "), if v.joins.is_empty() { String::new() } else { format!(" · joins: {}", v.joins.iter().map(|j| format!("{} ({})", j.tables.join(" ⋈ "), j.ty)).collect::<Vec<_>>().join("; ")) })))
                .child(ui::simple_table(&["Column", "Your access", "Used in"], rows, &[], cx)));
        }
        if let Some(vs) = &prop.validated_sql {
            panel = panel.child(v_flex().gap_1()
                .child(div().id("toggle-validated").text_xs().text_color(p.accent).cursor_pointer().child(if self.show_validated { "Hide the exact SQL that will run" } else { "Show the exact SQL that will run (rewritten by the server)" })
                    .on_click(cx.listener(|this, _, _, cx| { this.show_validated = !this.show_validated; cx.notify(); })))
                .children(self.show_validated.then(|| div().p_3().bg(p.code_bg).rounded(px(4.)).child(ui::mono(vs.clone(), cx)))));
        }
        panel.into_any_element()
    }

    fn results_panel(&self, cx: &App) -> AnyElement {
        let p = pal(cx);
        let Some(r) = &self.result else {
            return if self.phase == Phase::Running { ui::loading("Running on the server (read-only, time-limited). You can keep editing.", cx).into_any_element() }
                else { ui::empty("No results yet. Generation never runs a query; choose Preview or Run.", cx).into_any_element() };
        };
        let (tone, label) = match r.status.as_str() { "succeeded" => (Tone::Good, "Succeeded"), "timed_out" => (Tone::Bad, "Timed out"), "cancelled" => (Tone::Idle, "Cancelled"), _ => (Tone::Bad, "Failed") };
        let masked: Vec<String> = r.columns.iter().filter(|c| c.masked.is_some()).map(|c| format!("{} ({})", c.name, c.masked.clone().unwrap_or_default())).collect();
        v_flex().gap_2()
            .child(h_flex().gap_3().items_center().child(ui::signal(tone, label, cx))
                .child(ui::muted(format!("{} · {} row{}{} · {} ms · execution {}", r.mode, r.row_count, if r.row_count == 1 { "" } else { "s" }, if r.truncated { " (truncated at the row limit)" } else { "" }, r.duration_ms, &r.execution_id[..8]), cx)))
            .children(r.error.as_ref().map(|e| ui::note(Tone::Bad, format!("{} ({})", e.message, e.code), cx)))
            .children((!masked.is_empty()).then(|| ui::note(Tone::Warn, format!("Redacted by the server for your role: {}. The original values were never sent to this client.", masked.join(", ")), cx)))
            .child(div().h(px(380.)).w_full().border_1().border_color(p.rule).child(grid::grid_element(&self.grid)))
            .into_any_element()
    }
}

impl Render for QueryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(p) = self.pending_proposal.take() { self.set_proposal(p, window, cx); self.scroll_to = Some(SECTION_PROPOSAL); }
        if let Some(ix) = self.scroll_to.take() { self.scroll.scroll_to_top_of_item(ix); }
        if let Some((started, rows)) = self.applied_at.take() { perf::mark_after_next_frame(window, format!("query result ({rows} rows): request -> frame drawn"), started); }
        let p = pal(cx);
        let busy_gen = self.phase == Phase::Generating;
        let examples = EXAMPLES.iter().enumerate().map(|(i, e)| {
            let text: SharedString = (*e).into();
            div().id(("example", i)).px_2().py_1().rounded(px(10.)).bg(p.idle_bg).text_xs().text_color(p.ink2).cursor_pointer().hover(|d| d.bg(p.rule)).child(text.clone())
                .on_click(cx.listener(move |this, _, window, cx| { this.set_question(&text, window, cx); cx.notify(); }))
        });
        // Fixed child order (head, notes, ask, proposal, results) so sections can be scrolled to by index.
        let main = v_flex().id("query-main").flex_1().min_w(px(0.)).h_full().overflow_y_scroll().track_scroll(&self.scroll).p_8().gap_4()
            .child(ui::page_head("Query workspace", Some(ui::muted("Ask in plain English and get an inspectable SQL proposal. Your role and tenant are applied by the server, whatever the SQL says.", cx).into_any_element()), None, cx))
            .child(v_flex().children(self.error.as_ref().map(|e| {
                let extra = if e.code() == "provider_unavailable" { " You can still write or paste SQL below and validate it." } else { "" };
                ui::note(if matches!(e, ApiError::Forbidden { .. }) { Tone::Warn } else { Tone::Bad }, format!("{}{extra}", e.user_message()), cx)
            })).children(self.notice.as_ref().map(|(t, n)| ui::note(*t, n.clone(), cx))))
            .child(ui::section("ask", "Ask a question", None, v_flex().gap_2()
                .child(Input::new(&self.question))
                .child(h_flex().gap_2().flex_wrap().children(examples))
                .child(h_flex().gap_2().items_center()
                    .child(Button::new("generate").primary().label(if busy_gen { "Generating…" } else { "Generate SQL" }).loading(busy_gen).disabled(self.phase != Phase::Idle)
                        .on_click(cx.listener(|this, _, window, cx| this.generate(window, cx))))
                    .child(ui::muted("Ctrl+Enter also generates. Generating does not run anything.", cx))), cx))
            .child(ui::section("proposal", "Proposal", None, self.proposal_panel(cx), cx))
            .child(ui::section("results", "Results", None, self.results_panel(cx), cx));
        h_flex().size_full().items_start().child(main).child(self.catalog_panel(cx))
    }
}
