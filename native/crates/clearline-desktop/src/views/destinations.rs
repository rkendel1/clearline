//! Delivery destinations (delivery:manage): in-app recipients, email addresses, signed
//! webhooks and expiring exports, with format, notify-on rule, retries and an enable switch,
//! plus a test delivery that reports exactly what happened. Secrets are server-side references
//! (WEBHOOK_SECRET_<REF>); this view only shows whether they are configured.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use clearline_client::types::{Destinations, TestDelivery};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputState}, v_flex, Disableable};
use serde_json::{json, Value};

pub const KINDS: &[(&str, &str)] = &[("in_app", "In-app"), ("email", "Email"), ("webhook", "Webhook"), ("export", "Export (CSV)")];
pub const NOTIFY: &[&str] = &["always", "success", "failure", "anomaly"];

pub struct DestinationsView {
    c: Ctx,
    data: Resource<Destinations>,
    pub kind: &'static str,
    pub notify_on: &'static str,
    pub with_csv: bool,
    pub include_rows: bool,
    name: Entity<InputState>,
    target: Entity<InputState>,
    secret_ref: Entity<InputState>,
    max_attempts: Entity<InputState>,
    pub last_test: Option<TestDelivery>,
    pub notice: Option<(Tone, String)>,
    pub error: Option<ApiError>,
    busy: bool,
    task: Option<Task<()>>,
}

impl DestinationsView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mk = |ph: &str, window: &mut Window, cx: &mut Context<Self>| { let ph = ph.to_string(); cx.new(|cx| InputState::new(window, cx).placeholder(ph)) };
        let mut v = DestinationsView { name: mk("Name", window, cx), target: mk("Recipients: $owner or token names, comma-separated", window, cx), secret_ref: mk("Signing secret reference, e.g. OPS (server env WEBHOOK_SECRET_OPS)", window, cx),
            max_attempts: mk("Max attempts (default 5)", window, cx), c, data: Resource::default(), kind: "in_app", notify_on: "always", with_csv: false, include_rows: false,
            last_test: None, notice: None, error: None, busy: false, task: None };
        v.reload(cx);
        v
    }
    pub fn reload(&mut self, cx: &mut Context<Self>) { let (cl, t) = (self.c.client(), self.c.tenant()); self.data.load(cx, self.c.shell.clone(), |v| &mut v.data, move || cl.destinations(&t)); }
    pub fn busy(&self) -> bool { self.data.busy() || self.busy }
    pub fn set_kind(&mut self, k: &'static str, cx: &mut Context<Self>) { self.kind = k; cx.notify(); }
    pub fn set_field(&mut self, f: &str, v: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let t = match f { "name" => &self.name, "target" => &self.target, "secret_ref" => &self.secret_ref, "max_attempts" => &self.max_attempts, _ => return false };
        t.update(cx, |s, cx| s.set_value(v.to_string(), window, cx));
        true
    }

    fn body(&self, cx: &App) -> Value {
        let v = |e: &Entity<InputState>| e.read(cx).value().trim().to_string();
        let list: Vec<String> = v(&self.target).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        let config = match self.kind {
            "email" => json!({ "to": list }),
            "webhook" => json!({ "url": v(&self.target), "secret_ref": v(&self.secret_ref), "include_rows": self.include_rows }),
            _ => json!({ "recipients": if list.is_empty() { vec!["$owner".to_string()] } else { list } }),
        };
        let mut b = json!({ "name": v(&self.name), "kind": self.kind, "config": config, "notify_on": self.notify_on, "content": if self.with_csv { "summary_with_csv" } else { "summary" } });
        if let Ok(n) = v(&self.max_attempts).parse::<i64>() { b["max_attempts"] = json!(n); }
        b
    }

    pub fn create(&mut self, cx: &mut Context<Self>) {
        if self.busy { return; }
        let (cl, t, body) = (self.c.client(), self.c.tenant(), self.body(cx));
        self.busy = true; self.error = None; self.notice = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.create_destination(&t, &body), |this: &mut Self, r, cx| {
            this.busy = false;
            match r { Ok(d) => { this.notice = Some((Tone::Good, format!("Destination \"{}\" created.", d.name))); this.reload(cx); } Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    pub fn test(&mut self, id: String, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.busy = true; self.error = None; self.last_test = None;
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.test_destination(&t, &id), |this: &mut Self, r, _| {
            this.busy = false;
            match r { Ok(t) => this.last_test = Some(t), Err(e) => this.error = Some(e) }
        }));
        cx.notify();
    }

    pub fn set_enabled(&mut self, id: String, on: bool, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.update_destination(&t, &id, &json!({ "enabled": on })), |this: &mut Self, r, cx| match r { Ok(_) => this.reload(cx), Err(e) => this.error = Some(e) }));
    }

    pub fn id_of(&self, name: &str) -> Option<String> { self.data.ready()?.items.iter().find(|d| d.name == name).map(|d| d.id.clone()) }

    pub fn snapshot(&self, cx: &App) -> Value {
        json!({ "view": "destinations", "kind": self.kind, "body": self.body(cx),
            "items": self.data.ready().map(|d| d.items.iter().map(|x| json!({ "id": x.id, "name": x.name, "kind": x.kind, "notify_on": x.notify_on, "enabled": x.enabled, "secrets": x.secrets })).collect::<Vec<_>>()),
            "last_test": self.last_test, "notice": self.notice.as_ref().map(|n| n.1.clone()), "error": self.error.as_ref().map(|e| json!({ "code": e.code(), "message": e.user_message() })) })
    }
}

impl Render for DestinationsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let can = self.c.can("delivery:manage");
        let mut body = v_flex().w_full().gap_3().child(ui::page_head("Delivery destinations", Some(ui::muted("Where schedule results go. Before anything derived from data is sent, the server re-checks the run identity and the current field policy.", cx).into_any_element()),
            Some(Button::new("d-refresh").primary().label("Refresh").loading(self.data.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx))).into_any_element()), cx));
        if let Some(e) = self.data.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(d) = self.data.ready() {
            let rows = d.items.iter().map(|x| {
                let (a, b) = (x.id.clone(), x.id.clone());
                let target = match x.kind.as_str() {
                    "email" => x.config["to"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
                    "webhook" => format!("{} · secret {}", x.config["url"].as_str().unwrap_or(""), if x.secrets["signing"].as_bool() == Some(true) { "configured" } else { "MISSING" }),
                    _ => x.config["recipients"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default(),
                };
                vec![ui::text(x.name.clone()), ui::text(x.kind.replace('_', "-")), ui::muted(target, cx).into_any_element(), ui::text(format!("{} · {}", x.notify_on, x.content.replace('_', " "))),
                    if x.enabled { ui::signal(Tone::Good, "enabled", cx).into_any_element() } else { ui::signal(Tone::Idle, "disabled", cx).into_any_element() },
                    h_flex().gap_1().child(Button::new(SharedString::from(format!("dt-{}", x.id))).label("Test").disabled(!can).on_click(cx.listener(move |this, _, _, cx| this.test(a.clone(), cx))))
                        .child(Button::new(SharedString::from(format!("de-{}", x.id))).label(if x.enabled { "Disable" } else { "Enable" }).disabled(!can).on_click({ let on = !x.enabled; cx.listener(move |this, _, _, cx| this.set_enabled(b.clone(), on, cx)) })).into_any_element()]
            }).collect();
            body = body.child(if d.items.is_empty() { ui::empty("No destinations yet.", cx).into_any_element() } else { ui::simple_table_weighted(&["Name", "Kind", "Target", "Sends", "State", ""], rows, &[], &[1.1, 0.6, 2.2, 1.2, 0.7, 1.2], cx).into_any_element() });
        }
        if let Some(t) = &self.last_test {
            body = body.child(ui::note(if t.ok { Tone::Good } else { Tone::Bad }, format!("Test delivery ({}): {}{}{}", t.kind, if t.ok { "delivered" } else { "failed" },
                t.code.as_ref().map(|c| format!(" — {c}")).unwrap_or_default(), t.message.as_ref().map(|m| format!(": {m}")).unwrap_or_default()), cx));
        }
        if can {
            let row = |label: &str, c: AnyElement| h_flex().gap_3().items_center().child(div().w(px(120.)).text_xs().text_color(p.ink2).child(label.to_string())).child(div().flex_1().child(c));
            let mut form = v_flex().gap_2()
                .child(row("Kind", h_flex().gap_1().children(KINDS.iter().map(|(k, l)| { let k2: &'static str = k; ui::chip(SharedString::from(format!("dk-{k}")), *l, self.kind == *k, cx).on_click(cx.listener(move |this, _, _, cx| this.set_kind(k2, cx))) })).into_any_element()))
                .child(row("Name", Input::new(&self.name).into_any_element()))
                .child(row(match self.kind { "email" => "To (addresses)", "webhook" => "Endpoint (https)", _ => "Recipients" }, Input::new(&self.target).into_any_element()));
            if self.kind == "webhook" {
                form = form.child(row("Signing secret", Input::new(&self.secret_ref).into_any_element()))
                    .child(row("Rows", ui::chip("d-rows", if self.include_rows { "include result rows (bounded, redacted)" } else { "summary only" }, self.include_rows, cx).on_click(cx.listener(|this, _, _, cx| { this.include_rows = !this.include_rows; cx.notify(); })).into_any_element()));
            }
            if self.kind == "email" { form = form.child(row("Attachment", ui::chip("d-csv", if self.with_csv { "CSV attached" } else { "no attachment" }, self.with_csv, cx).on_click(cx.listener(|this, _, _, cx| { this.with_csv = !this.with_csv; cx.notify(); })).into_any_element())); }
            form = form.child(row("Send when", h_flex().gap_1().children(NOTIFY.iter().map(|n| { let n2: &'static str = n; ui::chip(SharedString::from(format!("dn-{n}")), *n, self.notify_on == *n, cx).on_click(cx.listener(move |this, _, _, cx| { this.notify_on = n2; cx.notify(); })) })).into_any_element()))
                .child(row("Retries", Input::new(&self.max_attempts).into_any_element()))
                .child(h_flex().child(Button::new("d-create").primary().label("Create destination").loading(self.busy).on_click(cx.listener(|this, _, _, cx| this.create(cx)))));
            if let Some(n) = &self.notice { form = form.child(ui::note(n.0, n.1.clone(), cx)); }
            if let Some(e) = &self.error { form = form.child(ui::error_state(e, cx)); }
            body = body.child(ui::section("new-destination", "New destination", Some("Webhooks: https only; private, loopback and link-local addresses are refused; every request is signed (HMAC-SHA256).".into()), form, cx));
        }
        div().id("destinations").size_full().overflow_y_scroll().p_8().child(body)
    }
}
