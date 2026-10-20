//! Contracts and migrations: versions with lifecycle, the active contract's
//! entities and fields (as the server shows them to this role), and migration
//! plans. Approvers can approve or reject a pending breaking migration.

use crate::app::Ctx;
use crate::data::{spawn_fetch, Resource};
use crate::ui::{self, pal, Tone};
use clearline_client::format::{cell, when};
use clearline_client::types::{ActiveContract, ContractVersion, Migration};
use gpui::{div, prelude::*, Context, FontWeight, SharedString, Task, Window};
use gpui_component::{button::{Button, ButtonVariants}, h_flex, v_flex};
use serde_json::{json, Value};

pub struct ContractsView {
    c: Ctx,
    versions: Resource<Vec<ContractVersion>>,
    active: Resource<ActiveContract>,
    migrations: Resource<Vec<Migration>>,
    notice: Option<(Tone, String)>,
    task: Option<Task<()>>,
}

impl ContractsView {
    pub fn new(c: Ctx, cx: &mut Context<Self>) -> Self {
        let mut v = ContractsView { c, versions: Resource::default(), active: Resource::default(), migrations: Resource::default(), notice: None, task: None };
        v.reload(cx);
        v
    }
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        let sh = self.c.shell.clone();
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.versions.load(cx, sh.clone(), |v| &mut v.versions, move || cl.contracts(&t));
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.active.load(cx, sh.clone(), |v| &mut v.active, move || cl.active_contract(&t));
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.migrations.load(cx, sh, |v| &mut v.migrations, move || cl.migrations(&t));
    }
    pub fn busy(&self) -> bool { self.versions.busy() || self.active.busy() || self.migrations.busy() }
    pub fn snapshot(&self) -> Value {
        json!({ "view": "contracts", "active": self.active.ready().map(|a| a.version.clone()), "versions": self.versions.ready().map(|v| v.iter().map(|x| json!([x.version, x.lifecycle])).collect::<Vec<_>>()),
            "entities": self.active.ready().and_then(|a| a.document.get("entities")).and_then(Value::as_object).map(|m| m.iter().map(|(k, e)| json!({ "entity": k, "fields": e.get("fields").and_then(Value::as_object).map(|f| f.keys().cloned().collect::<Vec<_>>()) })).collect::<Vec<_>>()),
            "migrations": self.migrations.ready().map(|m| m.iter().map(|x| json!([x.id.as_str(), x.status])).collect::<Vec<_>>()), "notice": self.notice.as_ref().map(|n| n.1.clone()) })
    }
    fn decide(&mut self, id: String, version: String, approve: bool, cx: &mut Context<Self>) {
        let (cl, t) = (self.c.client(), self.c.tenant());
        self.task = Some(spawn_fetch(cx, self.c.shell.clone(), move || if approve { cl.approve_migration(&t, &id, &version) } else { cl.reject_migration(&t, &id, "rejected in the native client") },
            move |this: &mut Self, r, cx| { this.notice = Some(match r { Ok(_) => (Tone::Good, format!("Migration {}.", if approve { "approved and applied" } else { "rejected" })), Err(e) => (Tone::Bad, e.user_message()) }); this.reload(cx); }));
    }
}

impl Render for ContractsView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let mut body = v_flex().w_full().child(ui::page_head("Contracts", Some(ui::muted("Data contracts define what the data means; every version and migration is recorded.", cx).into_any_element()), None, cx));
        if let Some((t, n)) = &self.notice { body = body.child(ui::note(*t, n.clone(), cx)); }
        for e in [self.versions.state.error(), self.active.state.error(), self.migrations.state.error()].into_iter().flatten() { body = body.child(ui::error_state(e, cx)); }
        if let Some(v) = self.versions.ready() {
            let rows = v.iter().map(|x| vec![ui::text(x.version.clone()), match x.lifecycle.as_str() { "active" => ui::signal(Tone::Good, "active", cx), "pending_approval" => ui::signal(Tone::Warn, "pending approval", cx), l => ui::signal(Tone::Idle, l.to_string(), cx) }.into_any_element(),
                ui::text(x.created_by.clone()), ui::text(when(x.created_at.as_deref())), ui::text(when(x.activated_at.as_deref())), ui::text(x.document_hash.get(..12).unwrap_or("").to_string())]).collect();
            body = body.child(ui::section("versions", "Versions", None, ui::simple_table(&["Version", "Lifecycle", "Published by", "Published", "Activated", "Hash"], rows, &[], cx), cx));
        }
        if let Some(m) = self.migrations.ready() {
            let can_approve = self.c.can("contract:approve");
            let mut sec = v_flex().gap_3();
            if m.is_empty() { sec = sec.child(ui::empty("No migrations.", cx)); }
            for (i, x) in m.iter().enumerate() {
                let changes = x.plan.get("changes").and_then(Value::as_array).cloned().unwrap_or_default();
                let pending = x.status == "planned";
                let (id, ver) = (x.id.as_str().unwrap_or("").to_string(), x.to_version.clone());
                let (id2, ver2) = (id.clone(), ver.clone());
                sec = sec.child(v_flex().gap_1().p_3().border_1().border_color(if pending { p.warn } else { p.rule })
                    .child(h_flex().gap_2().child(div().font_weight(FontWeight::BOLD).child(format!("{} → {}", x.from_version.clone().unwrap_or("none".into()), x.to_version)))
                        .child(ui::signal(if pending { Tone::Warn } else { Tone::Idle }, x.status.clone(), cx)).child(ui::muted(format!("{} · requested by {}{}", x.classification, x.requested_by, x.approved_by.as_ref().map(|a| format!(" · approved by {a}")).unwrap_or_default()), cx)))
                    .children(changes.iter().map(|c| ui::muted(format!("{} — {}", c.get("classification").map(cell).unwrap_or_default(), c.get("description").map(cell).unwrap_or_default()), cx)))
                    .children((pending && can_approve).then(|| h_flex().gap_2()
                        .child(Button::new(SharedString::from(format!("approve-{i}"))).primary().label("Approve and apply").on_click(cx.listener(move |this, _, _, cx| this.decide(id.clone(), ver.clone(), true, cx))))
                        .child(Button::new(SharedString::from(format!("reject-{i}"))).danger().label("Reject").on_click(cx.listener(move |this, _, _, cx| this.decide(id2.clone(), ver2.clone(), false, cx)))))));
            }
            body = body.child(ui::section("migrations", "Migrations", Some("Breaking changes wait for an approver; each plan lists every change and how it is applied.".into()), sec, cx));
        }
        if let Some(a) = self.active.ready() {
            let mut sec = v_flex().gap_3();
            if let Some(ents) = a.document.get("entities").and_then(Value::as_object) {
                for (name, e) in ents {
                    let rows = e.get("fields").and_then(Value::as_object).map(|f| f.iter().map(|(fname, def)| vec![ui::text(fname.clone()), ui::text(def.get("type").map(cell).unwrap_or_default()),
                        ui::text(def.get("sensitivity").map(cell).unwrap_or("internal".into())), ui::text(def.get("description").map(cell).unwrap_or_default())]).collect()).unwrap_or_default();
                    sec = sec.child(div().font_weight(FontWeight::BOLD).child(name.clone())).child(ui::simple_table(&["Field", "Type", "Classification", "Description"], rows, &[], cx));
                }
            }
            body = body.child(ui::section("active", format!("Active contract {}", a.version), Some(format!("Transform version {}. Fields hidden from your role by policy are not shown.", a.transform_version).into()), sec, cx));
        }
        div().id("contracts").size_full().overflow_y_scroll().p_8().child(body)
    }
}
