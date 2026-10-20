//! Schedule editor for a saved query: recurrence (once, hourly, daily, weekly, monthly), local
//! start and optional end in an IANA time zone, the role the schedule runs as (only roles this
//! token may delegate), destinations, and a preview of the next occurrences computed by the
//! server (so daylight-saving behaviour is exactly what will run). Parameter values come from
//! the library's parameter inputs.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use crate::views::library::LibraryView;
use clearline_client::types::{Destinations, ParamDecl, SchedulePreview};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, App, Context, Entity, FontWeight, SharedString, Task, WeakEntity, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputState}, v_flex, Disableable};
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub const FREQUENCIES: &[&str] = &["once", "hourly", "daily", "weekly", "monthly"];
pub const WEEKDAYS: &[&str] = &["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/// Roles a token may delegate a schedule to (mirrors the server's DELEGABLE_ROLES; the server decides).
pub fn delegable(role: &str) -> &'static [&'static str] {
    match role { "admin" => &["reporter", "operator", "steward", "admin"], "steward" => &["reporter", "steward"], "operator" => &["reporter", "operator"], "reporter" => &["reporter"], _ => &[] }
}

pub struct ScheduleEditor {
    c: Ctx,
    library: WeakEntity<LibraryView>,
    query_id: Option<String>,
    params: Vec<ParamDecl>,
    pub frequency: &'static str,
    pub weekdays: BTreeSet<&'static str>,
    interval: Entity<InputState>,
    at: Entity<InputState>,
    month_day: Entity<InputState>,
    start: Entity<InputState>,
    until: Entity<InputState>,
    timezone: Entity<InputState>,
    name: Entity<InputState>,
    pub run_as: String,
    pub destinations: BTreeSet<String>,
    dests: Resource<Destinations>,
    pub preview: Option<SchedulePreview>,
    pub error: Option<ApiError>,
    pub created: Option<String>,
    busy: bool,
    task: Option<Task<()>>,
}

fn local_timezone() -> String {
    std::env::var("TZ").ok().filter(|t| t.contains('/'))
        .or_else(|| std::fs::read_to_string("/etc/timezone").ok().map(|s| s.trim().to_string()).filter(|t| t.contains('/')))
        .unwrap_or_else(|| "UTC".into())
}

impl ScheduleEditor {
    pub fn new(c: Ctx, library: WeakEntity<LibraryView>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = |ph: &str, v: &str, window: &mut Window, cx: &mut Context<Self>| { let (ph, v) = (ph.to_string(), v.to_string()); cx.new(|cx| { let mut s = InputState::new(window, cx).placeholder(ph); s.set_value(v, window, cx); s }) };
        let tomorrow = clearline_client::format::now_epoch() + 86_400;
        let day = chrono_day(tomorrow);
        let run_as = delegable(c.session.me.role.as_str()).first().copied().unwrap_or("reporter").to_string();
        let mut e = ScheduleEditor {
            interval: input("1", "1", window, cx), at: input("HH:MM", "06:00", window, cx), month_day: input("1-31 or -1 (last day)", "1", window, cx),
            start: input("YYYY-MM-DDTHH:MM (local)", &format!("{day}T06:00"), window, cx), until: input("optional end, YYYY-MM-DDTHH:MM", "", window, cx),
            timezone: input("IANA time zone", &local_timezone(), window, cx), name: input("Schedule name (optional)", "", window, cx),
            c, library, query_id: None, params: vec![], frequency: "daily", weekdays: BTreeSet::from(["MO"]), run_as, destinations: BTreeSet::new(), dests: Resource::default(),
            preview: None, error: None, created: None, busy: false, task: None,
        };
        if e.c.can("schedule:manage") { let (cl, t) = (e.c.client(), e.c.tenant()); e.dests.load(cx, e.c.shell.clone(), |v| &mut v.dests, move || cl.destinations(&t)); }
        e
    }

    pub fn set_query(&mut self, id: String, params: Vec<ParamDecl>, cx: &mut Context<Self>) { self.query_id = Some(id); self.params = params; self.preview = None; self.created = None; self.error = None; cx.notify(); }

    pub fn set_field(&mut self, field: &str, value: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let target = match field { "interval" => &self.interval, "at" => &self.at, "month_day" => &self.month_day, "start_local" => &self.start, "until_local" => &self.until, "timezone" => &self.timezone, "name" => &self.name, _ => return false };
        target.update(cx, |s, cx| s.set_value(value.to_string(), window, cx));
        self.preview = None;
        true
    }
    pub fn set_frequency(&mut self, f: &'static str, cx: &mut Context<Self>) { self.frequency = f; self.preview = None; cx.notify(); }
    pub fn toggle_weekday(&mut self, d: &'static str, cx: &mut Context<Self>) { if !self.weekdays.remove(d) { self.weekdays.insert(d); } self.preview = None; cx.notify(); }
    pub fn set_run_as(&mut self, r: &str, cx: &mut Context<Self>) { self.run_as = r.to_string(); cx.notify(); }
    pub fn toggle_destination(&mut self, id: String, cx: &mut Context<Self>) { if !self.destinations.remove(&id) { self.destinations.insert(id); } cx.notify(); }
    pub fn busy(&self) -> bool { self.busy || self.dests.busy() }
    pub fn destination_id(&self, name: &str) -> Option<String> { self.dests.ready()?.items.iter().find(|d| d.name == name).map(|d| d.id.clone()) }

    fn recurrence(&self, cx: &App) -> Value {
        let v = |e: &Entity<InputState>| e.read(cx).value().trim().to_string();
        let interval = v(&self.interval).parse::<i64>().unwrap_or(1);
        let mut r = json!({ "frequency": self.frequency, "interval": interval });
        if self.frequency != "hourly" && self.frequency != "once" { r["at"] = json!(v(&self.at)); }
        if self.frequency == "weekly" { r["weekdays"] = json!(self.weekdays.iter().collect::<Vec<_>>()); }
        if self.frequency == "monthly" { r["month_day"] = json!(v(&self.month_day).parse::<i64>().unwrap_or(1)); }
        r
    }

    fn body(&self, cx: &App) -> Value {
        let v = |e: &Entity<InputState>| e.read(cx).value().trim().to_string();
        let until = v(&self.until);
        let params = self.library.upgrade().map(|l| l.read(cx).param_values(cx)).unwrap_or(json!({}));
        json!({ "query_id": self.query_id, "name": Some(v(&self.name)).filter(|s| !s.is_empty()), "recurrence": self.recurrence(cx), "start_local": v(&self.start), "timezone": v(&self.timezone),
            "until_local": if until.is_empty() { Value::Null } else { json!(until) }, "run_as_role": self.run_as, "destination_ids": self.destinations.iter().collect::<Vec<_>>(), "parameters": params, "count": 5 })
    }

    pub fn run_preview(&mut self, cx: &mut Context<Self>) {
        let (cl, t, body) = (self.c.client(), self.c.tenant(), self.body(cx));
        self.busy = true; self.error = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.preview_schedule(&t, &body), |this: &mut Self, r, _| {
            this.busy = false;
            match r { Ok(p) => this.preview = Some(p), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    pub fn create(&mut self, cx: &mut Context<Self>) {
        if self.query_id.is_none() || self.busy { return; }
        let (cl, t, body) = (self.c.client(), self.c.tenant(), self.body(cx));
        self.busy = true; self.error = None;
        let lib = self.library.clone();
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.create_schedule(&t, &body), move |this: &mut Self, r, cx| {
            this.busy = false;
            match r {
                Ok(s) => {
                    this.created = Some(s.id.clone());
                    let msg = format!("Schedule created: {}. Next run {}; runs as {} ({}).", s.description, clearline_client::format::when(s.next_run_at.as_deref()), s.run_as.actor, s.run_as.role);
                    let _ = lib.update(cx, |l, cx| { l.notice = Some((Tone::Good, msg)); l.refresh_selected(cx); });
                }
                Err(e) => this.error = Some(e),
            }
        }));
        cx.notify();
    }

    pub fn snapshot(&self, cx: &App) -> Value {
        json!({ "frequency": self.frequency, "run_as": self.run_as, "destinations": self.destinations, "body": self.body(cx), "busy": self.busy, "created": self.created,
            "preview": self.preview.as_ref().map(|p| json!({ "rrule": p.rrule, "description": p.description, "next": p.next })),
            "error": self.error.as_ref().map(|e| json!({ "code": e.code(), "message": e.user_message() })),
            "destinations_available": self.dests.ready().map(|d| d.items.iter().map(|x| json!({ "id": x.id, "name": x.name, "kind": x.kind })).collect::<Vec<_>>()) })
    }
}

impl Render for ScheduleEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let row = |label: &str, content: gpui::AnyElement| h_flex().gap_3().items_center().child(div().w(px(130.)).text_xs().text_color(p.ink2).child(label.to_string())).child(div().flex_1().child(content));
        let mut form = v_flex().gap_2()
            .child(row("Repeats", h_flex().gap_1().children(FREQUENCIES.iter().map(|f| {
                let f2: &'static str = f;
                ui::chip(SharedString::from(format!("freq-{f}")), *f, self.frequency == *f, cx).on_click(cx.listener(move |this, _, _, cx| this.set_frequency(f2, cx)))
            })).into_any_element()));
        if self.frequency != "once" { form = form.child(row(if self.frequency == "hourly" { "Every n hours" } else { "Every n" }, Input::new(&self.interval).into_any_element())); }
        if self.frequency != "once" && self.frequency != "hourly" { form = form.child(row("At (local time)", Input::new(&self.at).into_any_element())); }
        if self.frequency == "weekly" {
            form = form.child(row("On", h_flex().gap_1().children(WEEKDAYS.iter().map(|d| {
                let d2: &'static str = d;
                ui::chip(SharedString::from(format!("wd-{d}")), *d, self.weekdays.contains(d), cx).on_click(cx.listener(move |this, _, _, cx| this.toggle_weekday(d2, cx)))
            })).into_any_element()));
        }
        if self.frequency == "monthly" { form = form.child(row("Day of month", Input::new(&self.month_day).into_any_element())); }
        form = form.child(row("Starts", Input::new(&self.start).into_any_element()))
            .child(row("Ends", Input::new(&self.until).into_any_element()))
            .child(row("Time zone", Input::new(&self.timezone).into_any_element()))
            .child(row("Runs as", h_flex().gap_1().children(delegable(self.c.session.me.role.as_str()).iter().map(|r| {
                let role = r.to_string();
                ui::chip(SharedString::from(format!("runas-{r}")), format!("{} as {r}", self.c.session.me.actor), self.run_as == *r, cx).on_click(cx.listener(move |this, _, _, cx| this.set_run_as(&role, cx)))
            })).into_any_element()))
            .child(row("Deliver to", match self.dests.ready() {
                Some(d) if !d.items.is_empty() => h_flex().flex_wrap().gap_1().children(d.items.iter().filter(|x| x.enabled).map(|x| {
                    let id = x.id.clone();
                    ui::chip(SharedString::from(format!("dest-{}", x.id)), format!("{} ({}, {})", x.name, x.kind.replace('_', "-"), x.notify_on), self.destinations.contains(&x.id), cx)
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle_destination(id.clone(), cx)))
                })).into_any_element(),
                Some(_) => ui::muted("No destinations configured; runs still appear in run history.", cx).into_any_element(),
                None => ui::muted("Loading destinations…", cx).into_any_element(),
            }))
            .child(row("Name", Input::new(&self.name).into_any_element()))
            .child(ui::muted("The schedule runs as you with the role chosen above (never more), re-checked before every run and every delivery. Parameter values come from the Parameters section on the Overview tab.", cx))
            .child(h_flex().gap_2()
                .child(Button::new("sched-preview").label("Preview occurrences").loading(self.busy && self.preview.is_none()).on_click(cx.listener(|this, _, _, cx| this.run_preview(cx))))
                .child(Button::new("sched-create").primary().label("Create schedule").loading(self.busy).disabled(self.query_id.is_none() || self.busy).on_click(cx.listener(|this, _, _, cx| this.create(cx)))));
        if let Some(pv) = &self.preview {
            form = form.child(v_flex().gap_1().p_3().bg(p.code_bg).rounded(px(4.))
                .child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child(pv.description.clone()))
                .child(ui::mono(pv.rrule.clone().unwrap_or("once".into()), cx))
                .children(pv.next.iter().map(|t| ui::muted(format!("{t} (UTC)"), cx))));
        }
        if let Some(e) = &self.error { form = form.child(ui::error_state(e, cx)); }
        ui::section("schedule-editor", "New schedule", Some("Validated by the server: recurrence, time zone, daylight saving, parameters, identity and the query itself.".into()), form, cx)
    }
}

/// YYYY-MM-DD of an epoch (UTC), for the default start.
fn chrono_day(epoch: i64) -> String {
    let days = epoch.div_euclid(86_400);
    let (mut y, mut d) = (1970i64, days);
    loop { let len = if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 { 366 } else { 365 }; if d < len { break; } d -= len; y += 1; }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let months = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0;
    while d >= months[m] { d -= months[m]; m += 1; }
    format!("{y:04}-{:02}-{:02}", m + 1, d + 1)
}
