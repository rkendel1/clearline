//! Field policies: sensitivity, redaction style, who may see original values, and
//! per-role access, with the effective result for every role. Changes are sent to
//! the server, which decides whether they are allowed (stewards may only tighten),
//! versions and audits them, and regenerates the database grants.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use clearline_client::format::when;
use clearline_client::types::{FieldPolicies, PolicyPatch, PolicyVersion};
use clearline_client::ApiError;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, FontWeight, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, input::{Input, InputState}, v_flex, Disableable};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const ROLES: [&str; 4] = ["admin", "steward", "operator", "reporter"];
const LEVELS: [&str; 4] = ["hidden", "discover", "filter", "full"];

#[derive(Clone, Debug, PartialEq)]
pub struct Draft {
    pub entity: String,
    pub field: String,
    pub sensitive: bool,
    pub redaction: String,
    pub unmask: BTreeSet<String>,
    pub role_access: BTreeMap<String, String>,
    pub allowed: Vec<String>,
}

pub struct FieldsView {
    c: Ctx,
    list: Resource<FieldPolicies>,
    history: Resource<Vec<PolicyVersion>>,
    pub draft: Option<Draft>,
    pub reason: Entity<InputState>,
    applying: bool,
    pub outcome: Option<(Tone, String)>,
    task: Option<Task<()>>,
}

impl FieldsView {
    pub fn new(c: Ctx, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let reason = cx.new(|cx| InputState::new(window, cx).placeholder("Why is this field sensitive? (required when marking it sensitive)"));
        let mut v = FieldsView { c, list: Resource::default(), history: Resource::default(), draft: None, reason, applying: false, outcome: None, task: None };
        v.reload(cx);
        v
    }

    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.list.load(cx, self.c.shell.clone(), |v| &mut v.list, move || cl.field_policies(&t));
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.history.load(cx, self.c.shell.clone(), |v| &mut v.history, move || cl.policy_history(&t));
    }

    pub fn busy(&self) -> bool { self.list.busy() || self.history.busy() || self.applying }
    fn can_edit(&self) -> bool { self.c.can("policy:manage") }

    pub fn select(&mut self, entity: &str, field: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(list) = self.list.ready() else { return false };
        let Some(f) = list.entities.iter().find(|e| e.entity == entity).and_then(|e| e.fields.iter().find(|f| f.field == field)) else { return false };
        let pol = &f.policy;
        self.draft = Some(Draft { entity: entity.into(), field: field.into(), sensitive: pol.sensitive, redaction: pol.redaction.clone(),
            unmask: pol.unmask_roles.iter().cloned().collect(), role_access: pol.role_access.clone(), allowed: f.allowed_redactions.clone() });
        let reason = pol.reason.clone().unwrap_or_default();
        self.reason.update(cx, |r, cx| r.set_value(reason, window, cx));
        self.outcome = None;
        cx.notify();
        true
    }

    pub fn edit(&mut self, f: impl FnOnce(&mut Draft), cx: &mut Context<Self>) { if let Some(d) = &mut self.draft { f(d); cx.notify(); } }

    pub fn set_reason(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) { self.reason.update(cx, |r, cx| r.set_value(text.to_string(), window, cx)); }

    pub fn apply(&mut self, cx: &mut Context<Self>) {
        let Some(d) = self.draft.clone() else { return };
        if self.applying { return; }
        let current = self.list.ready().and_then(|l| l.entities.iter().find(|e| e.entity == d.entity)).and_then(|e| e.fields.iter().find(|f| f.field == d.field)).map(|f| f.policy.clone());
        let reason = self.reason.read(cx).value().trim().to_string();
        // Send only what changed; the server classifies the change and decides.
        let mut patch = PolicyPatch::default();
        if let Some(cur) = &current {
            if cur.sensitive != d.sensitive { patch.sensitive = Some(d.sensitive); }
            if cur.redaction != d.redaction { patch.redaction = Some(d.redaction.clone()); }
            if cur.reason.clone().unwrap_or_default() != reason { patch.reason = Some(reason); }
            if cur.unmask_roles.iter().cloned().collect::<BTreeSet<_>>() != d.unmask { patch.unmask_roles = Some(d.unmask.iter().cloned().collect()); }
            let full = |m: &BTreeMap<String, String>| ROLES.iter().map(|r| (r.to_string(), m.get(*r).cloned().unwrap_or("full".into()))).collect::<BTreeMap<_, _>>();
            if full(&cur.role_access) != full(&d.role_access) { patch.role_access = Some(full(&d.role_access)); }
        }
        self.applying = true;
        self.outcome = None;
        let (cl, t) = (self.c.client(), self.c.tenant());
        let (e, f) = (d.entity.clone(), d.field.clone());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || cl.change_policy(&t, &e, &f, &patch), move |this: &mut Self, r, cx| {
            this.applying = false;
            match r {
                Ok(u) => {
                    let eff = u.effective_access.as_ref().map(|m| m.iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                    this.outcome = Some((Tone::Good, format!("Saved version {} ({} change). Effective access now: {eff}. Every view re-reads data under the new policy.", u.policy.version, u.change.kind)));
                    let shell = this.c.shell.clone();
                    let _ = shell.update(cx, |s, cx| s.policy_changed(cx));
                    this.reload(cx);
                }
                Err(ApiError::Forbidden { code, message, .. }) => this.outcome = Some((Tone::Bad, format!("Refused by the server: {message} ({code})"))),
                Err(e) => this.outcome = Some((Tone::Bad, e.user_message())),
            }
        }));
        cx.notify();
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "view": "fields",
            "can_edit": self.can_edit(),
            "policy_epoch": self.list.ready().map(|l| l.policy_epoch),
            "fields": self.list.ready().map(|l| l.entities.iter().flat_map(|e| e.fields.iter().map(move |f| json!({ "entity": e.entity, "field": f.field,
                "sensitive": f.policy.sensitive, "redaction": f.policy.redaction, "unmask_roles": f.policy.unmask_roles, "effective": f.effective_access, "version": f.policy.version })))
                .collect::<Vec<_>>()),
            "draft": self.draft.as_ref().map(|d| json!({ "entity": d.entity, "field": d.field, "sensitive": d.sensitive, "redaction": d.redaction, "unmask": d.unmask, "role_access": d.role_access })),
            "outcome": self.outcome.as_ref().map(|o| o.1.clone()),
            "history": self.history.ready().map(|h| h.iter().take(20).map(|v| json!({ "field": format!("{}.{}", v.entity, v.field), "version": v.version, "kind": v.change_kind, "by": v.changed_by })).collect::<Vec<_>>()),
        })
    }

    fn chip(id: impl Into<SharedString>, label: impl Into<SharedString>, on: bool, cx: &App) -> gpui::Stateful<gpui::Div> {
        let p = pal(cx);
        div().id(id.into()).px_2().py(px(3.)).rounded(px(4.)).border_1().text_xs().cursor_pointer()
            .border_color(if on { p.accent } else { p.rule_strong }).bg(if on { p.accent } else { p.surface }).text_color(if on { p.accent_ink } else { p.ink2 })
            .child(label.into())
    }

    fn editor(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let Some(d) = &self.draft else { return ui::empty("Select a field to see or change its policy.", cx).into_any_element() };
        let editable = self.can_edit();
        let row = |label: &str, content: AnyElement| h_flex().gap_3().items_center().child(div().w(px(150.)).text_xs().text_color(p.ink2).child(label.to_string())).child(content);
        let sens = h_flex().gap_2()
            .child(Self::chip("sens-on", "Sensitive", d.sensitive, cx).on_click(cx.listener(|this, _, _, cx| this.edit(|d| d.sensitive = true, cx))))
            .child(Self::chip("sens-off", "Not sensitive", !d.sensitive, cx).on_click(cx.listener(|this, _, _, cx| this.edit(|d| d.sensitive = false, cx))));
        let red = h_flex().gap_2().children(d.allowed.iter().map(|s| {
            let style = s.clone();
            Self::chip(SharedString::from(format!("red-{s}")), s.clone(), d.redaction == *s, cx).on_click(cx.listener(move |this, _, _, cx| { let st = style.clone(); this.edit(|d| d.redaction = st, cx) }))
        }));
        let unmask = h_flex().gap_2().children(ROLES.iter().map(|r| {
            let role = r.to_string();
            Self::chip(SharedString::from(format!("unmask-{r}")), *r, d.unmask.contains(*r), cx)
                .on_click(cx.listener(move |this, _, _, cx| { let role = role.clone(); this.edit(|d| { if !d.unmask.remove(&role) { d.unmask.insert(role); } }, cx) }))
        }));
        let access = v_flex().gap_1().children(ROLES.iter().map(|r| {
            let cur = d.role_access.get(*r).cloned().unwrap_or("full".into());
            h_flex().gap_2().items_center().child(div().w(px(70.)).text_xs().child(r.to_string())).children(LEVELS.iter().map(|l| {
                let (role, level) = (r.to_string(), l.to_string());
                Self::chip(SharedString::from(format!("access-{r}-{l}")), *l, cur == *l, cx)
                    .on_click(cx.listener(move |this, _, _, cx| { let (role, level) = (role.clone(), level.clone()); this.edit(|d| { if level == "full" { d.role_access.remove(&role); } else { d.role_access.insert(role, level); } }, cx) }))
            }))
        }));
        v_flex().gap_3()
            .child(div().text_lg().font_weight(FontWeight::BOLD).child(format!("{}.{}", d.entity, d.field)))
            .child(row("Classification", sens.into_any_element()))
            .child(row("Redaction (when masked)", red.into_any_element()))
            .child(row("May view original values", unmask.into_any_element()))
            .child(row("Role access", access.into_any_element()))
            .child(row("Reason", Input::new(&self.reason).into_any_element()))
            .child(ui::muted("Sensitivity only lowers what a role receives: marking a field sensitive never grants access. Stewards may only make a policy stricter; widening needs an administrator.", cx))
            .child(h_flex().gap_2().child(Button::new("apply-policy").primary().label(if self.applying { "Saving…" } else { "Apply policy" }).loading(self.applying)
                .disabled(!editable || self.applying).on_click(cx.listener(|this, _, _, cx| this.apply(cx))))
                .children((!editable).then(|| ui::muted("Your role can view policies but not change them.", cx))))
            .children(self.outcome.as_ref().map(|(t, m)| ui::note(*t, m.clone(), cx)))
            .into_any_element()
    }
}

impl Render for FieldsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let mut body = v_flex().w_full().child(ui::page_head("Field policies", Some(ui::muted("Sensitivity and redaction are enforced by the server on every surface: queries, records, lineage, extracts and exports.", cx).into_any_element()), None, cx));
        if let Some(e) = self.list.state.error() { body = body.child(ui::error_state(e, cx)); }
        if let Some(list) = self.list.ready() {
            let selected = self.draft.as_ref().map(|d| (d.entity.clone(), d.field.clone()));
            for e in &list.entities {
                let rows = e.fields.iter().map(|f| {
                    let (en, fi) = (e.entity.clone(), f.field.clone());
                    let is_sel = selected.as_ref() == Some(&(en.clone(), fi.clone()));
                    vec![
                        div().id(SharedString::from(format!("field-{}-{}", e.entity, f.field))).text_color(p.accent).cursor_pointer().when(is_sel, |d| d.font_weight(FontWeight::BOLD))
                            .child(f.field.clone()).on_click(cx.listener(move |this, _, window, cx| { this.select(&en, &fi, window, cx); })).into_any_element(),
                        ui::text(f.ty.clone()), ui::text(f.contract_sensitivity.clone()),
                        if f.policy.sensitive { ui::signal(Tone::Warn, format!("sensitive · {}", f.policy.redaction), cx).into_any_element() } else { ui::text("—") },
                        v_flex().gap_1().children(ROLES.iter().map(|r| h_flex().gap_1().items_center().child(div().w(px(58.)).text_xs().text_color(p.muted).child(r.to_string()))
                            .child(ui::access_badge(f.effective_access.get(*r).map(String::as_str).unwrap_or("hidden"), cx)))).into_any_element(),
                        ui::text(if f.policy.version == 0 { "contract default".to_string() } else { format!("v{} by {}", f.policy.version, f.policy.updated_by.clone().unwrap_or_default()) }),
                    ]
                }).collect();
                body = body.child(ui::section("entity", e.entity.clone(), e.description.clone().map(Into::into),
                    ui::simple_table(&["Field", "Type", "Contract class", "Sensitivity", "Effective access by role", "Policy"], rows, &[], cx), cx));
            }
        } else if self.list.busy() { body = body.child(ui::loading("Loading field policies…", cx)); }
        if let Some(h) = self.history.ready() {
            let rows = h.iter().take(50).map(|v| vec![ui::text(when(Some(&v.changed_at))), ui::text(format!("{}.{}", v.entity, v.field)), ui::text(format!("v{}", v.version)),
                ui::signal(if v.change_kind == "tighten" { Tone::Good } else { Tone::Warn }, v.change_kind.clone(), cx).into_any_element(), ui::text(format!("{} ({})", v.changed_by, v.changed_role))]).collect();
            body = body.child(ui::section("policy-history", "Change history", Some("Append-only: every version, who changed it, and whether it narrowed or widened access.".into()),
                if h.is_empty() { ui::empty("No changes yet: all fields use their contract defaults.", cx).into_any_element() } else { ui::simple_table(&["When", "Field", "Version", "Change", "By"], rows, &[], cx).into_any_element() }, cx));
        }
        h_flex().size_full().items_start()
            .child(div().id("fields-main").flex_1().min_w(px(0.)).h_full().overflow_y_scroll().p_8().child(body))
            .child(div().id("fields-editor").w(px(460.)).flex_none().h_full().overflow_y_scroll().p_6().bg(p.surface).border_l_1().border_color(p.rule).child(self.editor(cx)))
    }
}
