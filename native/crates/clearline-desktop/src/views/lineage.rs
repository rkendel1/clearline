//! Lineage for one record key: every version, the source row and batch that
//! produced it, contract and transform versions, quality findings, metric
//! contribution and exports. Values follow the role's field policy (server-side).

use crate::app::{Ctx, Route};
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use clearline_client::format::{cell, short_id, when};
use clearline_client::types::{ActiveContract, Lineage};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, Context, Entity, FontWeight, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputEvent, InputState}, v_flex};
use serde_json::{json, Value};

pub struct LineageView {
    c: Ctx,
    contract: Resource<ActiveContract>,
    pub entity: String,
    pub key: Entity<InputState>,
    pub result: Option<Lineage>,
    error: Option<ApiError>,
    loading: bool,
    task: Option<Task<()>>,
}

impl LineageView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let key = cx.new(|cx| InputState::new(window, cx).placeholder("Record key, e.g. C000000104"));
        cx.subscribe_in(&key, window, |this, _, ev: &InputEvent, window, cx| { if let InputEvent::PressEnter { .. } = ev { this.submit(window, cx); } }).detach();
        let mut v = LineageView { c, contract: Resource::default(), entity: "claim".into(), key, result: None, error: None, loading: false, task: None };
        let (cl, t) = (v.c.client(), v.c.tenant());
        v.contract.load(cx, v.c.shell.clone(), |v| &mut v.contract, move || cl.active_contract(&t));
        v
    }

    pub fn busy(&self) -> bool { self.contract.busy() || self.loading }

    pub fn lookup(&mut self, entity: String, key: String, window: &mut Window, cx: &mut Context<Self>) {
        self.entity = entity;
        self.key.update(cx, |k, cx| k.set_value(key, window, cx));
        self.submit(window, cx);
    }

    fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let key = self.key.read(cx).value().trim().to_string();
        if key.is_empty() { return; }
        self.loading = true;
        self.error = None;
        let (cl, t, e) = (self.c.client(), self.c.tenant(), self.entity.clone());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.lineage(&t, &e, &key), |this: &mut Self, r, _| {
            this.loading = false;
            match r { Ok(l) => this.result = Some(l), Err(e) => { this.result = None; this.error = Some(e) } }
        }));
        cx.notify();
    }

    pub fn snapshot(&self) -> Value {
        json!({ "view": "lineage", "entity": self.entity, "error": self.error.as_ref().map(|e| e.user_message()),
            "versions": self.result.as_ref().map(|l| l.versions.iter().map(|v| json!({ "record_id": v.record_id, "is_current": v.is_current, "values": v.values,
                "source_columns": v.source_row.as_ref().and_then(|s| s.mapped_columns.clone()) })).collect::<Vec<_>>()) })
    }

    fn version(&self, v: &clearline_client::types::LineageVersion, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let batch_id = v.batch.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let shell = self.c.shell.clone();
        let bid = batch_id.clone();
        v_flex().gap_2().p_4().border_1().border_color(if v.is_current { p.accent } else { p.rule }).rounded(px(4.))
            .child(h_flex().gap_2().items_center().child(div().font_weight(FontWeight::BOLD).child(format!("Record {}", v.record_id)))
                .child(if v.is_current { ui::signal(Tone::Good, "current", cx) } else { ui::signal(Tone::Idle, "superseded", cx) })
                .children(v.is_late.then(|| ui::signal(Tone::Warn, "late", cx)))
                .child(ui::muted(format!("contract {} · loaded {}", v.contract_version, when(v.loaded_at.as_deref())), cx)))
            .child(h_flex().flex_wrap().gap_x_6().children(v.values.iter().map(|(k, val)| ui::fact(k.clone(), div().child(cell(val)), cx))))
            .child(h_flex().gap_2().items_center().child(ui::muted("From batch", cx))
                .child(div().id(SharedString::from(format!("lin-batch-{}-{}", v.record_id, batch_id))).text_color(p.accent).cursor_pointer().child(short_id(&batch_id).to_string())
                    .on_click(move |_, window, cx| { let _ = shell.update(cx, |s, cx| s.navigate(Route::Batch(bid.clone()), window, cx)); }))
                .child(ui::trust_signal(v.batch.get("trust_status").and_then(Value::as_str).unwrap_or(""), cx)))
            .children(v.source_row.as_ref().map(|s| v_flex().gap_1()
                .child(ui::muted(format!("Source row {} · disposition {} · {}", s.row_number.as_str().unwrap_or("?"), s.disposition.clone().unwrap_or_default(),
                    if s.payload_retained { "raw payload retained (mapped columns shown, as your role may see them)" } else { "raw payload purged by retention" }), cx))
                .children(s.mapped_columns.as_ref().map(|m| h_flex().flex_wrap().gap_x_6().children(m.iter().map(|(k, val)| ui::fact(k.clone(), div().font_family("DejaVu Sans Mono").child(cell(val)), cx)))))))
            .children((!v.metric_contribution.is_empty()).then(|| ui::muted(format!("Metrics: {}", v.metric_contribution.iter().map(|m| format!("{} ({})",
                m.get("metric_id").map(cell).unwrap_or_default(), m.get("reason").map(cell).unwrap_or_default())).collect::<Vec<_>>().join(", ")), cx)))
            .children((!v.exports.is_empty()).then(|| ui::muted(format!("Exported {} time(s)", v.exports.len()), cx)))
            .into_any_element()
    }
}

impl Render for LineageView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let entities: Vec<String> = self.contract.ready().and_then(|c| c.document.get("entities")).and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
        let tabs = h_flex().gap_2().children(entities.into_iter().map(|e| {
            let on = self.entity == e;
            let en = e.clone();
            div().id(SharedString::from(format!("lin-entity-{e}"))).px_3().py_1().rounded(px(4.)).cursor_pointer().text_sm()
                .bg(if on { p.accent } else { p.idle_bg }).text_color(if on { p.accent_ink } else { p.ink })
                .child(e).on_click(cx.listener(move |this, _, _, cx| { this.entity = en.clone(); cx.notify(); }))
        }));
        let mut body = v_flex().gap_3()
            .child(ui::page_head("Lineage", Some(ui::muted("From a canonical record back to the source row, batch, contract and checks that produced it.", cx).into_any_element()), None, cx))
            .child(tabs)
            .child(h_flex().gap_2().child(div().w(px(360.)).child(Input::new(&self.key)))
                .child(Button::new("lookup").primary().label(if self.loading { "Looking up…" } else { "Look up" }).loading(self.loading).on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))));
        if let Some(e) = &self.error { body = body.child(ui::error_state(e, cx)); }
        if let Some(l) = self.result.clone() {
            body = body.child(ui::muted(format!("{} {} · {} version(s) · current record {} · trusted record {}", l.entity, l.key, l.versions.len(),
                l.current_record_id.map(|x| x.to_string()).unwrap_or("—".into()), l.trusted_record_id.map(|x| x.to_string()).unwrap_or("—".into())), cx));
            for v in &l.versions { body = body.child(self.version(v, cx)); }
            if !l.quarantined_submissions.is_empty() { body = body.child(ui::note(Tone::Warn, format!("{} quarantined submission(s) for this key.", l.quarantined_submissions.len()), cx)); }
        }
        div().id("lineage").size_full().overflow_y_scroll().p_8().child(body)
    }
}
