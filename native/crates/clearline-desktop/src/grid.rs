//! Virtualized result grid (query results, records, audit). Rows are held once,
//! behind an `Arc`, and only the visible cells are formatted and laid out on each
//! frame, so a 5,000-row result costs the same per frame as a 20-row one. Values
//! are shown exactly as the API returned them; redacted columns are marked in the
//! header and their (already redacted) values are styled, never re-derived.

use crate::ui::pal;
use clearline_client::format::cell;
use gpui::{div, prelude::*, px, App, Context, Entity, FontWeight, Window};
use gpui_component::table::{Column, ColumnSort, Table, TableDelegate, TableState};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct GridColumn { pub name: String, pub masked: Option<String>, pub numeric: bool }

pub struct GridDelegate {
    pub cols: Vec<GridColumn>,
    columns: Vec<Column>,
    pub rows: Arc<Vec<Vec<Value>>>,
    order: Vec<usize>,
}

impl GridDelegate {
    pub fn new() -> Self { GridDelegate { cols: vec![], columns: vec![], rows: Arc::new(vec![]), order: vec![] } }

    pub fn set(&mut self, cols: Vec<GridColumn>, rows: Arc<Vec<Vec<Value>>>) {
        self.columns = cols.iter().map(|c| {
            let w = (c.name.len() as f32 * 9.0 + 48.0).clamp(110.0, 260.0);
            let col = Column::new(c.name.clone(), c.name.clone()).width(px(w)).sortable();
            if c.numeric { col.text_right() } else { col }
        }).collect();
        self.order = (0..rows.len()).collect();
        self.cols = cols;
        self.rows = rows;
    }

    /// The row index (into `rows`) displayed at position `ix` (sorting reorders only an index vector).
    pub fn row_at(&self, ix: usize) -> Option<&Vec<Value>> { self.order.get(ix).and_then(|i| self.rows.get(*i)) }

    /// Text of the cells currently displayed in the first `n` positions (for the end-to-end tests).
    pub fn displayed(&self, n: usize) -> Vec<Vec<String>> { (0..n.min(self.order.len())).filter_map(|i| self.row_at(i)).map(|r| r.iter().map(cell).collect()).collect() }
}

impl TableDelegate for GridDelegate {
    fn columns_count(&self, _: &App) -> usize { self.columns.len() }
    fn rows_count(&self, _: &App) -> usize { self.order.len() }
    fn column(&self, ix: usize, _: &App) -> &Column { &self.columns[ix] }

    fn render_th(&mut self, ix: usize, _: &mut Window, cx: &mut Context<TableState<Self>>) -> impl IntoElement {
        let p = pal(cx);
        let c = &self.cols[ix];
        div().flex().flex_row().gap_1().items_center().overflow_hidden().whitespace_nowrap().child(div().font_weight(FontWeight::SEMIBOLD).child(c.name.clone()))
            .children(c.masked.as_ref().map(|m| div().text_xs().text_color(p.warn_ink).child(format!("· redacted ({m})"))))
    }

    fn render_td(&mut self, row: usize, col: usize, _: &mut Window, cx: &mut Context<TableState<Self>>) -> impl IntoElement {
        let p = pal(cx);
        let v = self.row_at(row).and_then(|r| r.get(col)).cloned().unwrap_or(Value::Null);
        let masked = self.cols.get(col).and_then(|c| c.masked.as_ref()).is_some();
        let text = cell(&v);
        let d = div().overflow_hidden().whitespace_nowrap().child(text);
        if v.is_null() { d.text_color(p.muted) } else if masked { d.text_color(p.warn_ink).italic() } else { d }
    }

    fn perform_sort(&mut self, col: usize, sort: ColumnSort, _: &mut Window, _: &mut Context<TableState<Self>>) {
        let rows = self.rows.clone();
        let numeric = self.cols.get(col).is_some_and(|c| c.numeric);
        let key = |i: &usize| rows[*i].get(col).cloned().unwrap_or(Value::Null);
        match sort {
            ColumnSort::Default => self.order.sort(),
            s => {
                self.order.sort_by(|a, b| {
                    let (x, y) = (key(a), key(b));
                    let o = if numeric {
                        let f = |v: &Value| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(f64::MIN);
                        f(&x).partial_cmp(&f(&y)).unwrap_or(std::cmp::Ordering::Equal)
                    } else { cell(&x).cmp(&cell(&y)) };
                    if matches!(s, ColumnSort::Descending) { o.reverse() } else { o }
                });
            }
        }
    }

    fn render_empty(&mut self, _: &mut Window, cx: &mut Context<TableState<Self>>) -> impl IntoElement {
        div().p_4().text_sm().text_color(pal(cx).muted).child("No rows.")
    }
}

pub fn new_grid(window: &mut Window, cx: &mut App) -> Entity<TableState<GridDelegate>> {
    cx.new(|cx| TableState::new(GridDelegate::new(), window, cx).col_movable(false).row_selectable(true))
}

/// Replace the grid's contents (columns and rows) and redraw it.
pub fn set_grid(grid: &Entity<TableState<GridDelegate>>, cols: Vec<GridColumn>, rows: Arc<Vec<Vec<Value>>>, cx: &mut App) {
    grid.update(cx, |t, cx| { t.delegate_mut().set(cols, rows); t.refresh(cx); t.scroll_to_row(0, cx); cx.notify(); });
}

pub fn grid_element(grid: &Entity<TableState<GridDelegate>>) -> Table<GridDelegate> { Table::new(grid).stripe(true).bordered(true) }

pub fn is_numeric_type(t: &str) -> bool { matches!(t, "integer" | "decimal") }
