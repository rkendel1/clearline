//! In-app notifications for this token: successful runs, anomalies, forecasts and threshold
//! alerts, query / analysis / delivery failures and authorization problems. The server scopes
//! them to the recipient and withholds content about queries the recipient can no longer see.

use crate::app::{Ctx, Route};
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal};
use clearline_client::format::when;
use clearline_client::types::Notifications;
use gpui::{div, prelude::*, px, Context, FontWeight, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub struct NotificationsView { c: Ctx, pub data: Resource<Notifications>, pub unread_only: bool, task: Option<Task<()>> }

impl NotificationsView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self { let mut v = NotificationsView { c, data: Resource::default(), unread_only: false, task: None }; v.reload(cx); v }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t, u) = (self.c.client(), self.c.tenant(), self.unread_only);
        self.data.load(cx, self.c.shell.clone(), |v| &mut v.data, move || cl.notifications(&t, u));
    }
    pub fn busy(&self) -> bool { self.data.busy() }
    pub fn unread(&self) -> i64 { self.data.ready().map(|n| n.unread).unwrap_or(0) }
    pub fn mark(&mut self, id: String, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.mark_read(&t, &id), |this: &mut Self, _, cx| this.reload(cx)));
    }
    pub fn open(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(n) = self.data.ready().and_then(|d| d.items.get(index)).cloned() else { return false };
        if n.read_at.is_none() { self.mark(n.id.clone(), cx); }
        let Some(run) = n.run_id else { return false };
        let shell = self.c.shell.clone();
        let _ = shell.update(cx, |s, cx| s.navigate(Route::Run(run), window, cx));
        true
    }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "notifications", "unread": self.unread(), "error": self.data.state.error().map(|e| e.user_message()),
            "items": self.data.ready().map(|d| d.items.iter().map(|n| json!({ "id": n.id, "kind": n.kind, "severity": n.severity, "title": n.title, "body": n.body, "read": n.read_at.is_some(), "run_id": n.run_id, "links": n.links })).collect::<Vec<_>>()) })
    }
}

impl Render for NotificationsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let mut body = v_flex().w_full().gap_3().child(ui::page_head("Notifications", Some(ui::muted("Delivered by schedules and runs to this token. Open one to see the run, its insights and its deliveries.", cx).into_any_element()),
            Some(h_flex().gap_2().child(Button::new("n-unread").label(if self.unread_only { "Show all" } else { "Unread only" }).on_click(cx.listener(|this, _, _, cx| { this.unread_only = !this.unread_only; this.reload(cx); })))
                .child(Button::new("n-all-read").label("Mark all read").on_click(cx.listener(|this, _, _, cx| this.mark("all".into(), cx))))
                .child(Button::new("n-refresh").primary().label("Refresh").loading(self.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx)))).into_any_element()), cx));
        if let Some(e) = self.data.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(d) = self.data.ready() {
            if d.items.is_empty() { body = body.child(ui::empty("No notifications.", cx)); }
            for (i, n) in d.items.iter().enumerate() {
                body = body.child(v_flex().id(SharedString::from(format!("notif-{i}"))).gap_1().p_4().bg(p.surface).border_1().border_color(p.rule).rounded(px(4.)).cursor_pointer()
                    .when(n.read_at.is_none(), |x| x.border_l_4().border_color(p.accent))
                    .on_click(cx.listener(move |this, _, window, cx| { this.open(i, window, cx); }))
                    .child(h_flex().gap_2().items_center().child(ui::severity(&n.severity, cx)).child(ui::tag(n.kind.replace('_', " "), cx))
                        .child(div().text_sm().font_weight(if n.read_at.is_none() { FontWeight::BOLD } else { FontWeight::NORMAL }).child(n.title.clone()))
                        .child(ui::muted(when(n.created_at.as_deref()), cx)))
                    .child(div().text_sm().text_color(p.ink2).child(n.body.lines().take(6).collect::<Vec<_>>().join("\n"))));
            }
        } else if self.busy() { body = body.child(ui::loading("Loading notifications…", cx)); }
        div().id("notifications").size_full().overflow_y_scroll().p_8().child(body)
    }
}
