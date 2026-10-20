//! Records: current canonical records per entity (claims, members, ...), paged and
//! virtualized. Values arrive already redacted for the role; fields the role may
//! not see are absent from the response. Select a row to open its lineage.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::grid::{self, GridColumn, GridDelegate};
use crate::ui::{self, pal};
use clearline_client::types::{ActiveContract, Records};
use gpui::{div, prelude::*, px, Context, Entity, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, table::TableState, v_flex, Disableable};
use serde_json::{json, Value};
use std::sync::Arc;

pub const PAGE: u32 = 500;

pub struct RecordsView {
    c: Ctx,
    contract: Resource<ActiveContract>,
    pub entity: Option<String>,
    pub offset: u32,
    pub page: Option<Records>,
    loading: bool,
    error: Option<clearline_client::ApiError>,
    pub grid: Entity<TableState<GridDelegate>>,
    task: Option<Task<()>>,
}

impl RecordsView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let grid = grid::new_grid(window, cx);
        let mut v = RecordsView { c, contract: Resource::default(), entity: None, offset: 0, page: None, loading: false, error: None, grid, task: None };
        let (cl, t) = (v.c.client(), v.c.tenant());
        v.contract.load(cx, v.c.shell.clone(), |v| &mut v.contract, move || cl.active_contract(&t));
        v
    }

    pub fn busy(&self) -> bool { self.contract.busy() || self.loading }

    fn entities(&self) -> Vec<String> {
        self.contract.ready().and_then(|c| c.document.get("entities")).and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn open(&mut self, entity: String, offset: u32, cx: &mut Context<Self>) {
        self.entity = Some(entity.clone());
        self.offset = offset;
        self.loading = true;
        self.error = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.records(&t, &entity, PAGE, offset), |this: &mut Self, r, cx| {
            this.loading = false;
            match r {
                Ok(page) => {
                    let mut names = vec!["_key".to_string()];
                    names.extend(page.fields.iter().cloned());
                    names.push("_trust_status".into());
                    let rows: Vec<Vec<Value>> = page.records.iter().map(|rec| names.iter().map(|n| rec.get(n).cloned().unwrap_or(Value::Null)).collect()).collect();
                    // The server says which fields it redacted (and how); the client only labels them.
                    let cols = names.iter().map(|n| GridColumn { name: n.clone(), masked: page.redacted.get(n).cloned(), numeric: false }).collect();
                    grid::set_grid(&this.grid, cols, Arc::new(rows), cx);
                    this.page = Some(page);
                }
                Err(e) => this.error = Some(e),
            }
        }));
        cx.notify();
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) { if let Some(e) = self.entity.clone() { let o = self.offset; self.open(e, o, cx); } }

    fn open_lineage(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(entity) = self.entity.clone() else { return };
        let g = self.grid.read(cx);
        let Some(key) = g.selected_row().and_then(|ix| g.delegate().row_at(ix)).and_then(|r| r.first()).and_then(Value::as_str).map(str::to_string) else { return };
        let shell = self.c.shell.clone();
        let _ = shell.update(cx, |s, cx| s.open_lineage(entity, key, window, cx));
    }

    pub fn snapshot(&self, cx: &gpui::App) -> Value {
        let g = self.grid.read(cx).delegate();
        json!({ "view": "records", "entity": self.entity, "entities": self.entities(), "total": self.page.as_ref().map(|p| p.total), "offset": self.offset,
            "fields": self.page.as_ref().map(|p| p.fields.clone()), "columns": g.cols.iter().map(|c| json!({ "name": c.name, "masked": c.masked })).collect::<Vec<_>>(),
            "grid_rows": g.rows.len(), "displayed": g.displayed(10), "error": self.error.as_ref().map(|e| e.user_message()) })
    }
}

impl Render for RecordsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let tabs = h_flex().gap_2().children(self.entities().into_iter().map(|e| {
            let on = self.entity.as_deref() == Some(e.as_str());
            let en = e.clone();
            div().id(SharedString::from(format!("entity-{e}"))).px_3().py_1().rounded(px(4.)).cursor_pointer().text_sm()
                .bg(if on { p.accent } else { p.idle_bg }).text_color(if on { p.accent_ink } else { p.ink })
                .child(e).on_click(cx.listener(move |this, _, _, cx| this.open(en.clone(), 0, cx)))
        }));
        let total = self.page.as_ref().map(|p| p.total).unwrap_or(0) as u32;
        let paging = h_flex().gap_2().items_center()
            .child(Button::new("prev").label("Previous").disabled(self.offset == 0 || self.loading).on_click(cx.listener(|this, _, _, cx| { if let Some(e) = this.entity.clone() { let o = this.offset.saturating_sub(PAGE); this.open(e, o, cx); } })))
            .child(Button::new("next").label("Next").disabled(self.offset + PAGE >= total || self.loading).on_click(cx.listener(|this, _, _, cx| { if let Some(e) = this.entity.clone() { let o = this.offset + PAGE; this.open(e, o, cx); } })))
            .child(ui::muted(if total > 0 { format!("{}–{} of {} current records", self.offset + 1, (self.offset + PAGE).min(total), total) } else { String::new() }, cx))
            .child(div().flex_1())
            .child(Button::new("open-lineage").primary().label("Open lineage of selected row").disabled(self.page.is_none()).on_click(cx.listener(|this, _, window, cx| this.open_lineage(window, cx))));
        v_flex().id("records").size_full().p_8().gap_3()
            .child(ui::page_head("Records", Some(ui::muted("Current version of every record. Fields your role may not see are not sent; redacted values are redacted by the server.", cx).into_any_element()), None, cx))
            .children(self.contract.state.error().map(|e| ui::error_state(e, cx)))
            .children(self.error.as_ref().map(|e| ui::error_state(e, cx)))
            .child(tabs)
            .child(paging)
            .child(if self.entity.is_some() { div().flex_1().w_full().border_1().border_color(p.rule).child(grid::grid_element(&self.grid)).into_any_element() }
                else { ui::empty("Choose an entity.", cx).into_any_element() })
    }
}
