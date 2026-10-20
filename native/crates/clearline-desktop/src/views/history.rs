//! Query history: proposals and execution metadata (never result rows). The server
//! re-validates every entry for the viewer under the current policy and withholds
//! SQL that refers to data the viewer may not use; entries run under an older
//! policy are flagged.

use crate::app::Ctx;
use crate::data::Resource;
use crate::ui::{self, pal, Tone};
use clearline_client::format::when;
use clearline_client::types::History;
use gpui::{div, prelude::*, px, Context, FontWeight, SharedString, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub struct HistoryView { c: Ctx, data: Resource<History>, pub all: bool }

impl HistoryView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self {
        let mut v = HistoryView { c, data: Resource::default(), all: false };
        v.reload(cx);
        v
    }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t, all) = (self.c.client(), self.c.tenant(), self.all);
        self.data.load(cx, self.c.shell.clone(), |v| &mut v.data, move || cl.history(&t, all));
    }
    pub fn set_all(&mut self, all: bool, cx: &mut Context<Self>) { self.all = all; self.reload(cx); }
    pub fn busy(&self) -> bool { self.data.busy() }
    pub fn open(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(item) = self.data.ready().and_then(|h| h.items.get(index)) else { return false };
        let Some(sql) = item.proposed_sql.clone() else { return false };
        let (shell, id) = (self.c.shell.clone(), item.id.clone());
        let _ = shell.update(cx, |s, cx| s.open_in_workspace(sql, Some(id), window, cx));
        true
    }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "history", "all": self.all, "error": self.data.state.error().map(|e| e.user_message()),
            "items": self.data.ready().map(|h| h.items.iter().map(|i| json!({ "id": i.id, "actor": i.actor, "status": i.status, "question": i.question, "proposed_sql": i.proposed_sql,
                "withheld": i.withheld, "stale_policy": i.stale_policy, "executions": i.executions.iter().map(|e| json!({ "status": e.status, "rows": e.row_count })).collect::<Vec<_>>() })).collect::<Vec<_>>()) })
    }
}

impl Render for HistoryView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let can_all = self.c.can("query:history_all");
        let mut body = v_flex().w_full().gap_3().child(ui::page_head("Query history", Some(ui::muted("Questions, proposals and outcomes. Result rows are never stored; re-run a query to see current data under the current policy.", cx).into_any_element()),
            Some(h_flex().gap_2().children(can_all.then(|| Button::new("toggle-all").label(if self.all { "Show only mine" } else { "Show everyone's" }).on_click(cx.listener(|this, _, _, cx| { let a = !this.all; this.set_all(a, cx); }))))
                .child(Button::new("refresh-h").primary().label("Refresh").loading(self.busy()).on_click(cx.listener(|this, _, _, cx| this.reload(cx)))).into_any_element()), cx));
        if let Some(e) = self.data.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(h) = self.data.ready() {
            if h.items.is_empty() { body = body.child(ui::empty("No queries yet.", cx)); }
            for (i, item) in h.items.iter().enumerate() {
                let (tone, label) = match item.status.as_str() { "valid" => (Tone::Good, "valid"), "rejected" => (Tone::Bad, "rejected"), _ => (Tone::Warn, "generation failed") };
                let mut card = v_flex().gap_2().p_4().bg(p.surface).border_1().border_color(p.rule).rounded(px(4.))
                    .child(h_flex().gap_2().items_center().child(ui::signal(tone, label, cx)).child(ui::tag(item.source.clone(), cx))
                        .child(ui::muted(format!("{} ({}) · {}", item.actor, item.role, when(item.created_at.as_deref())), cx))
                        .children(item.stale_policy.then(|| ui::signal(Tone::Warn, "field policies changed since", cx))));
                if let Some(q) = &item.question { card = card.child(div().font_weight(FontWeight::SEMIBOLD).child(q.clone())); }
                if item.withheld { card = card.child(ui::note(Tone::Warn, "SQL withheld: it refers to data that is not available to your role under the current policy.", cx)); }
                if let Some(sql) = &item.proposed_sql { card = card.child(div().p_2().bg(p.code_bg).rounded(px(3.)).child(ui::mono(sql.clone(), cx))); }
                for e in &item.executions {
                    card = card.child(ui::muted(format!("{} {} · {} rows{} · {} ms · {}", e.mode, e.status, e.row_count.unwrap_or(0), if e.truncated == Some(true) { " (truncated)" } else { "" },
                        e.duration_ms.unwrap_or(0), when(e.started_at.as_deref())), cx));
                }
                if item.proposed_sql.is_some() {
                    card = card.child(h_flex().child(Button::new(SharedString::from(format!("open-{i}"))).label("Open in workspace").on_click(cx.listener(move |this, _, window, cx| { this.open(i, window, cx); }))));
                }
                body = body.child(card);
            }
        } else if self.busy() { body = body.child(ui::loading("Loading history…", cx)); }
        div().id("history").size_full().overflow_y_scroll().p_8().child(body)
    }
}
