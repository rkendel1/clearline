//! Audit trail (append-only), in a virtualized grid. Payloads carry identifiers,
//! hashes and counts, never record values.

use crate::app::Ctx;
use crate::data::Resource;
use crate::grid::{self, GridColumn, GridDelegate};
use crate::ui::{self, pal};
use clearline_client::types::AuditEvent;
use gpui::{div, prelude::*, px, Context, Entity, SharedString, Window};
use gpui_component::{h_flex, table::TableState, v_flex};
use serde_json::{json, Value};
use std::sync::Arc;

const FILTERS: [(&str, Option<&str>); 5] = [("All", None), ("Queries", Some("query.")), ("Field policy", Some("policy.")), ("Denials", Some("authz.")), ("Extracts", Some("extract."))];

pub struct AuditView { c: Ctx, events: Resource<Vec<AuditEvent>>, filter: usize, grid: Entity<TableState<GridDelegate>>, shown_for: Option<usize> }

impl AuditView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let grid = grid::new_grid(window, cx);
        let mut v = AuditView { c, events: Resource::default(), filter: 0, grid, shown_for: None };
        v.reload(cx);
        v
    }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t, f) = (self.c.client(), self.c.tenant(), FILTERS[self.filter].1);
        self.shown_for = None;
        self.events.load(cx, self.c.shell.clone(), |v| &mut v.events, move || cl.audit(&t, f, 2000));
    }
    pub fn busy(&self) -> bool { self.events.busy() }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "audit", "filter": FILTERS[self.filter].0, "events": self.events.ready().map(|e| e.iter().take(30).map(|x| json!([x.action, x.outcome, x.actor])).collect::<Vec<_>>()),
            "error": self.events.state.error().map(|e| e.user_message()) })
    }
}

impl Render for AuditView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        if self.shown_for.is_none() {
            if let Some(ev) = self.events.ready() {
                let rows: Vec<Vec<Value>> = ev.iter().map(|e| vec![json!(e.at), json!(e.actor), json!(e.role), json!(e.action), json!(e.resource), json!(e.outcome), json!(e.details.to_string())]).collect();
                let cols = ["at", "actor", "role", "action", "resource", "outcome", "details"].iter().map(|n| GridColumn { name: n.to_string(), masked: None, numeric: false }).collect();
                grid::set_grid(&self.grid, cols, Arc::new(rows), cx);
                self.shown_for = Some(self.filter);
            }
        }
        let tabs = h_flex().gap_2().children(FILTERS.iter().enumerate().map(|(i, (label, _))| {
            let on = self.filter == i;
            div().id(SharedString::from(format!("audit-f-{i}"))).px_3().py_1().rounded(px(4.)).cursor_pointer().text_sm()
                .bg(if on { p.accent } else { p.idle_bg }).text_color(if on { p.accent_ink } else { p.ink }).child(*label)
                .on_click(cx.listener(move |this, _, _, cx| { this.filter = i; this.reload(cx); cx.notify(); }))
        }));
        v_flex().id("audit").size_full().p_8().gap_3()
            .child(ui::page_head("Audit", Some(ui::muted("Every access, decision and change, append-only. Payloads never contain record values.", cx).into_any_element()), None, cx))
            .children(self.events.state.error().map(|e| ui::error_state(e, cx)))
            .child(tabs)
            .child(div().flex_1().w_full().border_1().border_color(p.rule).child(grid::grid_element(&self.grid)))
    }
}
