//! Saved-query library: search, filter and sort saved queries; open one to see its SQL,
//! parameters, versions, schedules, analyses and recent runs; run it now, preview it, save a
//! new version, duplicate, favorite or archive it. Every action is a server request; the
//! server decides what this token may see and do (a saved query is not a permission).

use crate::app::{Ctx, Route};
use crate::data::{spawn_fetch, Resource};
use crate::grid::{self, GridColumn, GridDelegate};
use crate::ui::{self, pal, Tone};
use crate::views::{analysis_builder::AnalysisBuilder, schedule_editor::ScheduleEditor};
use clearline_client::format::when;
use clearline_client::types::{ParamDecl, SavedExecution, SavedQueryDetail, SavedQueryList};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, FontWeight, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputEvent, InputState}, table::TableState, v_flex, Disableable, Sizable};
use serde_json::{json, Map, Value};
use std::sync::Arc;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tab { Overview, Sql, Schedules, Analyses }

pub const SCOPES: &[(&str, &str)] = &[("all", "All"), ("mine", "My queries"), ("shared", "Shared"), ("favorites", "Favorites"), ("archived", "Archived")];
pub const SORTS: &[(&str, &str)] = &[("updated", "Recently changed"), ("recent", "Recently used"), ("name", "Name"), ("last_run", "Last run")];

pub struct LibraryView {
    c: Ctx,
    search: Entity<InputState>,
    pub scope: &'static str,
    pub sort: &'static str,
    list: Resource<SavedQueryList>,
    pub selected: Option<String>,
    pub detail: Resource<SavedQueryDetail>,
    pub tab: Tab,
    params: Vec<(ParamDecl, Entity<InputState>)>,
    built_for: Option<(String, i64)>,
    sql_editor: Entity<InputState>,
    params_editor: Entity<InputState>,
    change_note: Entity<InputState>,
    pub preview: Option<SavedExecution>,
    grid: Entity<TableState<GridDelegate>>,
    pub schedule_editor: Entity<ScheduleEditor>,
    pub analysis_builder: Entity<AnalysisBuilder>,
    pub notice: Option<(Tone, String)>,
    pub error: Option<ApiError>,
    pub last_queued: Option<String>,
    action: Option<&'static str>,
    task: Option<Task<()>>,
}

impl LibraryView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search name, description, tags or category"));
        cx.subscribe_in(&search, window, |this, _, ev: &InputEvent, _, cx| { if let InputEvent::Change = ev { this.reload(cx); } }).detach();
        let sql_editor = cx.new(|cx| InputState::new(window, cx).code_editor("sql").line_number(true));
        let change_note = cx.new(|cx| InputState::new(window, cx).placeholder("What changed and why (recorded on the version)"));
        let params_editor = cx.new(|cx| InputState::new(window, cx).multi_line(true).auto_grow(2, 10)
            .placeholder("Parameter declarations (JSON), e.g. [{\"name\": \"start\", \"type\": \"date\", \"default\": \"2026-04-04\"}]"));
        let grid = grid::new_grid(window, cx);
        let weak = cx.entity().downgrade();
        let schedule_editor = cx.new(|cx| ScheduleEditor::new(c.clone(), weak.clone(), window, cx));
        let analysis_builder = cx.new(|cx| AnalysisBuilder::new(c.clone(), weak, window, cx));
        let mut v = LibraryView { c, search, scope: "all", sort: "updated", list: Resource::default(), selected: None, detail: Resource::default(), tab: Tab::Overview,
            params: vec![], built_for: None, sql_editor, params_editor, change_note, preview: None, grid, schedule_editor, analysis_builder, notice: None, error: None, last_queued: None, action: None, task: None };
        v.reload(cx);
        v
    }

    pub fn busy(&self) -> bool { self.list.busy() || self.detail.busy() || self.action.is_some() }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        let q = self.search.read(cx).value().trim().to_string();
        let mut qs = vec![format!("sort={}", self.sort)];
        match self.scope { "favorites" => qs.push("favorite=true".into()), "archived" => qs.push("status=archived".into()), s => qs.push(format!("scope={s}")) }
        if !q.is_empty() { qs.push(format!("q={}", urlenc(&q))); }
        let query = format!("?{}", qs.join("&"));
        self.list.load(cx, self.c.shell.clone(), |v| &mut v.list, move || cl.saved_queries(&t, &query));
    }

    pub fn set_search(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) { self.search.update(cx, |s, cx| s.set_value(text.to_string(), window, cx)); self.reload(cx); }
    pub fn set_scope(&mut self, s: &'static str, cx: &mut Context<Self>) { self.scope = s; self.reload(cx); }
    pub fn set_sort(&mut self, s: &'static str, cx: &mut Context<Self>) { self.sort = s; self.reload(cx); }

    pub fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected = Some(id.clone());
        self.preview = None;
        self.notice = None;
        self.error = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.detail.load(cx, self.c.shell.clone(), |v| &mut v.detail, move || cl.saved_query(&t, &id));
        cx.notify();
    }

    /// Re-read the selected query (after a version, schedule or analysis change) and the list.
    pub fn refresh_selected(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() { self.select(id, cx); }
        self.reload(cx);
    }

    pub fn set_tab(&mut self, t: Tab, cx: &mut Context<Self>) { self.tab = t; cx.notify(); }

    /// Effective parameter values typed by the user (empty = server default).
    pub fn param_values(&self, cx: &App) -> Value {
        let mut m = Map::new();
        for (d, input) in &self.params {
            let v = input.read(cx).value().trim().to_string();
            if !v.is_empty() { m.insert(d.name.clone(), Value::String(v)); }
        }
        Value::Object(m)
    }

    pub fn set_param(&mut self, name: &str, value: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some((_, input)) = self.params.iter().find(|(d, _)| d.name == name) else { return false };
        input.update(cx, |s, cx| s.set_value(value.to_string(), window, cx));
        true
    }

    fn act<T: Send + 'static>(&mut self, name: &'static str, cx: &mut Context<Self>, f: impl FnOnce() -> clearline_client::Result<T> + Send + 'static, done: impl FnOnce(&mut Self, T, &mut Context<Self>) + 'static) {
        if self.action.is_some() { return; }
        self.action = Some(name);
        self.error = None;
        self.notice = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), f, move |this: &mut Self, r, cx| {
            this.action = None;
            match r { Ok(v) => done(this, v, cx), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    fn sel(&self) -> Option<String> { self.selected.clone() }

    pub fn run_now(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.sel() else { return };
        let (cl, t, params) = (self.c.client(), self.c.tenant(), self.param_values(cx));
        self.act("run", cx, move || cl.run_saved(&t, &id, &params, None), |this, q, cx| {
            this.last_queued = Some(q.run_id.clone());
            this.notice = Some((Tone::Good, format!("Run {} queued. The scheduler executes it (query, analyses) in the background; open it from Recent runs.", &q.run_id[..8])));
            this.refresh_selected(cx);
        });
    }

    pub fn preview_rows(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.sel() else { return };
        let (cl, t, params) = (self.c.client(), self.c.tenant(), self.param_values(cx));
        self.act("preview", cx, move || cl.execute_saved(&t, &id, "preview", &params), |this, r, cx| {
            let cols = r.columns.iter().map(|c| GridColumn { name: c.name.clone(), masked: c.masked.clone(), numeric: grid::is_numeric_type(&c.ty) }).collect();
            grid::set_grid(&this.grid, cols, Arc::new(r.rows.clone()), cx);
            this.preview = Some(r);
        });
    }

    pub fn toggle_favorite(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.detail.ready() else { return };
        let (cl, t, id, on) = (self.c.client(), self.c.tenant(), d.id.clone(), !d.favorite);
        self.act("favorite", cx, move || cl.set_favorite(&t, &id, on), |this, _, cx| this.refresh_selected(cx));
    }

    pub fn duplicate(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.sel() else { return };
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.act("duplicate", cx, move || cl.duplicate_saved_query(&t, &id, None), |this, d, cx| {
            this.notice = Some((Tone::Good, format!("Duplicated as \"{}\" (private, owned by you).", d.name)));
            this.select(d.id, cx);
            this.reload(cx);
        });
    }

    pub fn set_status(&mut self, status: &'static str, cx: &mut Context<Self>) {
        let Some(id) = self.sel() else { return };
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.act("status", cx, move || cl.set_saved_status(&t, &id, status), move |this, _, cx| {
            this.notice = Some((Tone::Good, format!("Saved query {status}.{}", if status == "active" { "" } else { " Its schedules were paused." } )));
            this.refresh_selected(cx);
        });
    }

    pub fn set_version_fields(&mut self, sql: Option<&str>, params: Option<&str>, note: Option<&str>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(v) = sql { self.sql_editor.update(cx, |s, cx| s.set_value(v.to_string(), window, cx)); }
        if let Some(v) = params { self.params_editor.update(cx, |s, cx| s.set_value(v.to_string(), window, cx)); }
        if let Some(v) = note { self.change_note.update(cx, |s, cx| s.set_value(v.to_string(), window, cx)); }
    }

    pub fn save_version(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.sel() else { return };
        let sql = self.sql_editor.read(cx).value().to_string();
        let note = self.change_note.read(cx).value().to_string();
        // Declarations are edited as JSON; the server validates names, types, defaults and ranges.
        let raw = self.params_editor.read(cx).value().trim().to_string();
        let params: Value = if raw.is_empty() { json!([]) } else {
            match serde_json::from_str(&raw) { Ok(v) => v, Err(e) => { self.notice = Some((Tone::Bad, format!("Parameter declarations are not valid JSON: {e}"))); cx.notify(); return; } }
        };
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.act("version", cx, move || cl.new_version(&t, &id, &json!({ "sql": sql, "parameters": params, "change_note": note })), |this, d, cx| {
            let flagged = d.current.analyses.iter().filter(|a| a.get("state").and_then(Value::as_str) == Some("needs_revalidation")).count();
            this.notice = Some((if flagged > 0 { Tone::Warn } else { Tone::Good }, format!("Saved version {}.{}", d.version,
                if flagged > 0 { format!(" {flagged} analysis configuration(s) no longer match the output and need revalidation.") } else { String::new() })));
            this.built_for = None;
            this.refresh_selected(cx);
        });
    }

    pub fn open_run(&mut self, run_id: String, window: &mut Window, cx: &mut Context<Self>) {
        let shell = self.c.shell.clone();
        let _ = shell.update(cx, |s, cx| s.navigate(Route::Run(run_id), window, cx));
    }

    /// Inputs that depend on the loaded detail (parameters, SQL editor) need a Window: rebuilt in render.
    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(d) = self.detail.ready() else { return };
        let key = (d.id.clone(), d.version);
        if self.built_for.as_ref() == Some(&key) { return; }
        let d = d.clone();
        self.params = d.current.parameters.iter().map(|p| {
            let def = match &p.default { Value::String(s) => s.clone(), Value::Number(n) => n.to_string(), Value::Bool(b) => b.to_string(), Value::Object(o) => format!("(relative: {})", Value::Object(o.clone())), _ => String::new() };
            let placeholder = if def.is_empty() { format!("{} ({})", p.label.clone().unwrap_or(p.name.clone()), p.ty) } else { format!("default {def}") };
            (p.clone(), cx.new(|cx| InputState::new(window, cx).placeholder(placeholder)))
        }).collect();
        let sql = d.current.sql.clone().unwrap_or_default();
        self.sql_editor.update(cx, |s, cx| s.set_value(sql, window, cx));
        let decls: Vec<Value> = d.current.parameters.iter().map(|p| {
            let mut v = serde_json::to_value(p).unwrap_or(Value::Null);
            // Leave out unset fields so the editor shows only what was declared.
            if let Some(o) = v.as_object_mut() { o.retain(|k, x| !(x.is_null() || (k == "allowed" && x.as_array().is_some_and(|a| a.is_empty())) || (k == "required" && x == &json!(true)))); }
            v
        }).collect();
        let decls = if decls.is_empty() { String::new() } else { serde_json::to_string_pretty(&decls).unwrap_or_default() };
        self.params_editor.update(cx, |s, cx| s.set_value(decls, window, cx));
        self.change_note.update(cx, |s, cx| s.set_value(String::new(), window, cx));
        let schema = d.current.output_schema.clone().unwrap_or_default();
        let (qid, analyses, params) = (d.id.clone(), d.current.analyses.clone(), d.current.parameters.clone());
        self.analysis_builder.update(cx, |a, cx| a.set_query(qid.clone(), schema, analyses, window, cx));
        self.schedule_editor.update(cx, |s, cx| s.set_query(qid, params, cx));
        self.built_for = Some(key);
    }

    pub fn snapshot(&self, cx: &App) -> Value {
        json!({
            "view": "library", "scope": self.scope, "sort": self.sort, "search": self.search.read(cx).value().to_string(),
            "items": self.list.ready().map(|l| l.items.iter().map(|i| json!({ "id": i.id, "name": i.name, "owner": i.owner, "mine": i.mine, "sharing": i.sharing, "status": i.status, "version": i.version,
                "favorite": i.favorite, "tags": i.tags, "analyses": i.analyses, "active_schedules": i.active_schedules, "last_run": i.last_run.as_ref().map(|r| &r.status) })).collect::<Vec<_>>()),
            "selected": self.selected, "tab": format!("{:?}", self.tab),
            "detail": self.detail.ready().map(|d| json!({ "id": d.id, "name": d.name, "version": d.version, "status": d.status, "withheld": d.withheld, "executable_now": d.executable_now,
                "needs_revalidation": d.needs_revalidation, "sql": d.current.sql, "parameters": d.current.parameters.iter().map(|p| &p.name).collect::<Vec<_>>(),
                "output_schema": d.current.output_schema, "analyses": d.current.analyses, "versions": d.versions.iter().map(|v| v.version).collect::<Vec<_>>(),
                "schedules": d.schedules.iter().map(|s| json!({ "id": s.id, "status": s.status, "rrule": s.rrule, "timezone": s.timezone, "next_run_at": s.next_run_at, "attention": s.attention })).collect::<Vec<_>>(),
                "recent_runs": d.recent_runs.iter().map(|r| json!({ "id": r.id, "status": r.status, "version": r.query_version })).collect::<Vec<_>>() })),
            "preview": self.preview.as_ref().map(|p| json!({ "status": p.status, "row_count": p.row_count, "columns": p.columns, "version": p.version })),
            "schedule_editor": self.schedule_editor.read(cx).snapshot(cx),
            "analysis_builder": self.analysis_builder.read(cx).snapshot(cx),
            "last_queued": self.last_queued, "notice": self.notice.as_ref().map(|n| n.1.clone()),
            "error": self.error.as_ref().map(|e| json!({ "code": e.code(), "message": e.user_message() })),
        })
    }

    // ------------------------------------------------------------------ rendering

    fn list_panel(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let mut col = v_flex().gap_2()
            .child(Input::new(&self.search))
            .child(h_flex().flex_wrap().gap_1().children(SCOPES.iter().map(|(id, label)| {
                let s: &'static str = id;
                ui::chip(SharedString::from(format!("scope-{id}")), *label, self.scope == *id, cx).on_click(cx.listener(move |this, _, _, cx| this.set_scope(s, cx)))
            })))
            .child(h_flex().flex_wrap().gap_1().children(SORTS.iter().map(|(id, label)| {
                let s: &'static str = id;
                ui::chip(SharedString::from(format!("sort-{id}")), *label, self.sort == *id, cx).on_click(cx.listener(move |this, _, _, cx| this.set_sort(s, cx)))
            })));
        if let Some(e) = self.list.state.error() { col = col.child(ui::error_state(e, cx)); }
        match self.list.ready() {
            Some(l) if l.items.is_empty() => col = col.child(ui::empty("No saved queries match. Save one from the query workspace.", cx)),
            Some(l) => for (i, q) in l.items.iter().enumerate() {
                let id = q.id.clone();
                let sel = self.selected.as_deref() == Some(q.id.as_str());
                let run = q.last_run.as_ref();
                col = col.child(v_flex().id(SharedString::from(format!("sq-{i}"))).gap_1().p_3().rounded(px(4.)).border_1().cursor_pointer()
                    .border_color(if sel { p.accent } else { p.rule }).bg(if sel { p.rail_active.opacity(0.08) } else { p.surface })
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
                    .child(h_flex().gap_2().items_center().child(div().font_weight(FontWeight::SEMIBOLD).text_sm().child(q.name.clone())).children(q.favorite.then(|| div().text_color(p.warn_ink).child("★"))))
                    .child(h_flex().flex_wrap().gap_1().child(ui::tag(format!("v{}", q.version), cx)).child(ui::tag(if q.mine { "mine".to_string() } else { format!("by {}", q.owner) }, cx))
                        .children((q.sharing == "tenant").then(|| ui::tag("shared", cx))).children((q.status != "active").then(|| ui::signal(Tone::Warn, q.status.clone(), cx)))
                        .children(q.tags.iter().take(3).map(|t| ui::tag(format!("#{t}"), cx))))
                    .child(ui::muted(format!("{}{}{}", run.map(|r| format!("last run {} · {}", r.status, when(r.at.as_deref()))).unwrap_or("never run".into()),
                        if q.active_schedules > 0 { format!(" · next {}", when(q.next_run_at.as_deref())) } else { String::new() },
                        if q.analyses > 0 { format!(" · {} analyses", q.analyses) } else { String::new() }), cx))
                    .children(q.needs_revalidation.as_ref().map(|_| ui::signal(Tone::Warn, "analyses need revalidation", cx))));
            },
            None => if self.list.busy() { col = col.child(ui::loading("Loading saved queries…", cx)); },
        }
        col.into_any_element()
    }

    fn detail_panel(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        if let Some(e) = self.detail.state.error() { return ui::error_state(e, cx).into_any_element(); }
        let Some(d) = self.detail.ready().cloned() else {
            return if self.detail.busy() { ui::loading("Loading…", cx).into_any_element() } else { ui::empty("Select a saved query to see its SQL, parameters, versions, schedules, analyses and runs.", cx).into_any_element() };
        };
        let writable = d.mine || self.c.can("saved_query:admin");
        let busy = |a: &str| self.action == Some(a);
        let mut col = v_flex().gap_3();
        col = col.child(v_flex().gap_2()
            .child(v_flex().gap_1().min_w(px(0.))
                .child(div().text_xl().font_weight(FontWeight::BOLD).child(d.name.clone()))
                .child(h_flex().flex_wrap().gap_1().child(ui::tag(format!("version {}", d.version), cx)).child(ui::tag(format!("owner {} ({})", d.owner, d.owner_role), cx))
                    .child(ui::tag(if d.sharing == "tenant" { "shared with the tenant" } else { "private" }, cx)).child(ui::signal(if d.status == "active" { Tone::Good } else { Tone::Warn }, d.status.clone(), cx))
                    .children(d.tags.iter().map(|t| ui::tag(format!("#{t}"), cx)))))
            .child(h_flex().gap_2().flex_wrap()
                .child(Button::new("sq-run").primary().label("Run now").loading(busy("run")).disabled(d.status != "active" || !self.c.can("analysis:run") || !d.executable_now).on_click(cx.listener(|this, _, _, cx| this.run_now(cx))))
                .child(Button::new("sq-preview").label("Preview").loading(busy("preview")).disabled(d.status != "active" || !d.executable_now).on_click(cx.listener(|this, _, _, cx| this.preview_rows(cx))))
                .child(Button::new("sq-fav").label(if d.favorite { "★ Favorite" } else { "☆ Favorite" }).on_click(cx.listener(|this, _, _, cx| this.toggle_favorite(cx))))
                .child(Button::new("sq-dup").label("Duplicate").loading(busy("duplicate")).disabled(!self.c.can("saved_query:write") || d.withheld).on_click(cx.listener(|this, _, _, cx| this.duplicate(cx))))
                .children(writable.then(|| if d.status == "active" {
                    Button::new("sq-archive").label("Archive").on_click(cx.listener(|this, _, _, cx| this.set_status("archived", cx))).into_any_element()
                } else if d.status == "disabled" {
                    Button::new("sq-enable").label("Enable").on_click(cx.listener(|this, _, _, cx| this.set_status("active", cx))).into_any_element()
                } else { div().into_any_element() }))));
        if let Some(n) = &self.notice { col = col.child(ui::note(n.0, n.1.clone(), cx)); }
        if let Some(e) = &self.error { col = col.child(ui::error_state(e, cx)); }
        if d.withheld { col = col.child(ui::note(Tone::Warn, "This shared query uses data that is not available to your role under the current field policy; its SQL is withheld and it cannot run as you.", cx)); }
        else if !d.executable_now { col = col.child(ui::note(Tone::Warn, format!("Not executable for your role now: {}", d.issues.first().map(|i| i.message.clone()).unwrap_or_default()), cx)); }
        if let Some(r) = &d.needs_revalidation { col = col.child(ui::note(Tone::Warn, r.clone(), cx)); }
        col = col.child(h_flex().gap_1().children([(Tab::Overview, "Overview"), (Tab::Sql, "SQL and versions"), (Tab::Schedules, "Schedules"), (Tab::Analyses, "Analyses")].map(|(t, l)| {
            ui::chip(SharedString::from(format!("tab-{l}")), l, self.tab == t, cx).on_click(cx.listener(move |this, _, _, cx| this.set_tab(t, cx)))
        })));
        let body: AnyElement = match self.tab {
            Tab::Overview => {
                let mut b = v_flex().gap_3();
                for (k, v) in [("Description", &d.description), ("Business purpose", &d.purpose), ("Category", &d.category), ("Business owner", &d.business_owner)] {
                    if let Some(v) = v { b = b.child(ui::fact(k, div().text_sm().child(v.clone()), cx)); }
                }
                if let Some(q) = &d.current.question { b = b.child(ui::fact("Original request", div().text_sm().italic().child(format!("\u{201c}{q}\u{201d}")), cx)); }
                if !self.params.is_empty() {
                    b = b.child(ui::section("params", "Parameters", Some("Values are validated and bound by the server; leave empty for the default.".into()),
                        v_flex().gap_2().children(self.params.iter().map(|(dcl, input)| h_flex().gap_3().items_center()
                            .child(v_flex().w(px(170.)).child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(dcl.label.clone().unwrap_or(dcl.name.clone()))).child(ui::muted(format!(":{} · {}{}", dcl.name, dcl.ty, if dcl.required { "" } else { " · optional" }), cx)))
                            .child(div().flex_1().child(Input::new(input))))), cx));
                }
                if let Some(cols) = &d.current.output_schema {
                    let rows = cols.iter().map(|c| vec![ui::text(c.name.clone()), ui::text(c.ty.clone()),
                        c.masked.as_ref().map(|m| ui::signal(Tone::Warn, format!("redacted ({m})"), cx).into_any_element()).unwrap_or_else(|| ui::text("—")),
                        if c.sensitive { ui::signal(Tone::Warn, "sensitive source", cx).into_any_element() } else { ui::text("") }]).collect();
                    b = b.child(ui::section("schema", "Output", Some("As observed for the saver's role when this version was saved; checked again on every run.".into()), ui::simple_table(&["Column", "Type", "Redaction", ""], rows, &[], cx), cx));
                }
                if let Some(pv) = &self.preview {
                    b = b.child(ui::section("preview", "Preview", Some(format!("{} rows as your role sees them now (version {}).", pv.row_count, pv.version).into()), div().h(px(260.)).child(grid::grid_element(&self.grid)), cx));
                }
                let runs: Vec<Vec<AnyElement>> = d.recent_runs.iter().map(|r| {
                    let id = r.id.clone();
                    vec![div().id(SharedString::from(format!("run-{}", r.id))).text_color(p.accent).cursor_pointer().child(r.id[..8].to_string())
                            .on_click(cx.listener(move |this, _, window, cx| this.open_run(id.clone(), window, cx))).into_any_element(),
                        ui::text(r.trigger.clone()), ui::run_signal(&r.status, cx).into_any_element(), ui::text(format!("v{}", r.query_version)),
                        ui::text(format!("q {} · a {} · d {}", r.query_status, r.analysis_status, r.delivery_status)), ui::text(when(r.created_at.as_deref()))]
                }).collect();
                b = b.child(ui::section("recent-runs", "Recent runs", Some("Each run keeps the exact version and parameters it used.".into()),
                    if runs.is_empty() { ui::empty("No runs yet.", cx).into_any_element() } else { ui::simple_table(&["Run", "Trigger", "Status", "Version", "Phases", "When"], runs, &[], cx).into_any_element() }, cx));
                b.into_any_element()
            }
            Tab::Sql => {
                let rows = d.versions.iter().map(|v| vec![ui::text(format!("v{}", v.version)), ui::text(v.change_note.clone().unwrap_or_default()), ui::text(v.created_by.clone()), ui::text(when(v.created_at.as_deref())),
                    ui::mono(v.sql_sha256[..12].to_string(), cx).into_any_element()]).collect();
                v_flex().gap_3()
                    .child(div().h(px(220.)).child(Input::new(&self.sql_editor).h_full()))
                    .child(v_flex().gap_1().child(ui::muted("Parameters: reference them in the SQL as :name; values are always bound, never spliced into the text.", cx)).child(Input::new(&self.params_editor)))
                    .child(Input::new(&self.change_note))
                    .child(h_flex().gap_2().child(Button::new("sq-version").primary().label("Save as new version").loading(busy("version")).disabled(!writable || d.withheld || d.status == "archived")
                        .on_click(cx.listener(|this, _, _, cx| this.save_version(cx))))
                        .child(ui::muted("The server validates the SQL for your role; earlier versions and the runs that used them are kept unchanged.", cx)))
                    .child(ui::section("versions", "Version history", None, ui::simple_table(&["Version", "Change", "By", "When", "SQL sha256"], rows, &[], cx), cx))
                    .into_any_element()
            }
            Tab::Schedules => {
                let rows: Vec<Vec<AnyElement>> = d.schedules.iter().map(|s| {
                    let (a, b, c2, d2) = (s.id.clone(), s.id.clone(), s.id.clone(), s.id.clone());
                    vec![v_flex().child(div().text_sm().child(s.name.clone())).child(ui::muted(s.description.clone(), cx)).into_any_element(),
                        ui::run_signal(&s.status, cx).into_any_element(), ui::text(when(s.next_run_at.as_deref())), ui::text(format!("{} as {}", s.run_as_actor, s.run_as_role)),
                        v_flex().gap_1().children(s.attention.as_ref().map(|t| ui::signal(Tone::Bad, t.clone(), cx)))
                            .child(h_flex().flex_wrap().gap_1()
                                .child(Button::new(SharedString::from(format!("s-run-{a}"))).small().label("Run now").on_click(cx.listener(move |this, _, _, cx| this.schedule_action(a.clone(), "run", cx))))
                                .child(if s.status == "paused" { Button::new(SharedString::from(format!("s-res-{b}"))).small().label("Resume").on_click(cx.listener(move |this, _, _, cx| this.schedule_action(b.clone(), "resume", cx))) }
                                       else { Button::new(SharedString::from(format!("s-pau-{b}"))).small().label("Pause").on_click(cx.listener(move |this, _, _, cx| this.schedule_action(b.clone(), "pause", cx))) })
                                .child(Button::new(SharedString::from(format!("s-can-{c2}"))).small().label("Cancel").on_click(cx.listener(move |this, _, _, cx| this.schedule_action(c2.clone(), "cancel", cx))))
                                .children(s.last_run_id.clone().map(|rid| Button::new(SharedString::from(format!("s-last-{d2}"))).small().label("Last run").on_click(cx.listener(move |this, _, window, cx| this.open_run(rid.clone(), window, cx))))))
                            .into_any_element()]
                }).collect();
                v_flex().gap_3()
                    .child(ui::section("schedules", "Schedules", Some("Schedules run in the Clearline worker, whether or not this application is open.".into()),
                        if rows.is_empty() { ui::empty("No schedules.", cx).into_any_element() } else { ui::simple_table_weighted(&["Schedule", "Status", "Next run", "Runs as", "Actions"], rows, &[], &[1.5, 0.7, 1.0, 1.1, 2.0], cx).into_any_element() }, cx))
                    .children(self.c.can("schedule:manage").then(|| self.schedule_editor.clone().into_any_element()))
                    .into_any_element()
            }
            Tab::Analyses => self.analysis_builder.clone().into_any_element(),
        };
        col.child(body).into_any_element()
    }

    pub fn schedule_action(&mut self, id: String, action: &'static str, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        if action == "run" {
            self.act("schedule", cx, move || cl.run_schedule_now(&t, &id), |this, q, cx| {
                this.last_queued = Some(q.run_id.clone());
                this.notice = Some((Tone::Good, format!("Run {} queued under the schedule's identity.", &q.run_id[..8])));
                this.refresh_selected(cx);
            });
        } else {
            self.act("schedule", cx, move || cl.schedule_action(&t, &id, action), move |this, s, cx| {
                this.notice = Some((Tone::Good, format!("Schedule {}: {}.", action, s.status)));
                this.refresh_selected(cx);
            });
        }
    }
}

impl Render for LibraryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        self.sync_inputs(window, cx);
        let list = self.list_panel(cx);
        let detail = self.detail_panel(cx);
        v_flex().size_full()
            .child(div().px_8().pt_8().child(ui::page_head("Saved queries", Some(ui::muted("Reusable, versioned queries with schedules and analyses. Saving a query grants nothing: every run is re-checked under the current policy.", cx).into_any_element()),
                Some(Button::new("lib-refresh").label("Refresh").loading(self.list.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx))).into_any_element()), cx)))
            .child(h_flex().flex_1().min_h(px(0.)).items_start().gap_4().px_8().pb_4()
                .child(div().id("lib-list").w(px(360.)).flex_none().h_full().overflow_y_scroll().child(list))
                .child(div().id("lib-detail").flex_1().min_w(px(0.)).h_full().overflow_y_scroll().p_5().bg(p.surface).border_1().border_color(p.rule).rounded(px(6.)).child(detail)))
    }
}

pub fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}
