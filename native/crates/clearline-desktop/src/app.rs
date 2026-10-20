//! Application shell: session lifecycle, navigation rail, routing and theme.
//! Which views are offered follows the permissions the server reports for the
//! token; the server still authorizes every request the views make.

use crate::perf::Perf;
use crate::theme::{self, Palette};
use crate::ui::{self, pal, Tone};
use crate::views::{audit::AuditView, batch::BatchView, contracts::ContractsView, destinations::DestinationsView, exceptions::ExceptionsView, fields::FieldsView, history::HistoryView,
    library::LibraryView, lineage::LineageView, metrics::MetricsView, notifications::NotificationsView, overview::OverviewView, query::QueryView, records::RecordsView, run::RunView,
    runs::RunsView, signin::SignInView};
use clearline_client::Session;
use gpui::{div, prelude::*, px, AnyElement, App, Context, Entity, FontWeight, Hsla, SharedString, WeakEntity, Window};
use gpui_component::{h_flex, v_flex};
use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum Route { Overview, Batch(String), Exceptions, Records, Lineage, Contracts, Metrics, Query, History, Fields, Audit, Library, Runs, Run(String), Notifications, Destinations }

impl Route {
    pub fn id(&self) -> &'static str {
        match self {
            Route::Overview => "overview", Route::Batch(_) => "batch", Route::Exceptions => "exceptions", Route::Records => "records", Route::Lineage => "lineage",
            Route::Contracts => "contracts", Route::Metrics => "metrics", Route::Query => "query", Route::History => "history", Route::Fields => "fields", Route::Audit => "audit",
            Route::Library => "library", Route::Runs => "runs", Route::Run(_) => "run", Route::Notifications => "notifications", Route::Destinations => "destinations",
        }
    }
    pub fn parse(s: &str, arg: Option<&str>) -> Option<Route> {
        Some(match s {
            "overview" => Route::Overview, "batch" => Route::Batch(arg?.to_string()), "exceptions" => Route::Exceptions, "records" => Route::Records,
            "lineage" => Route::Lineage, "contracts" => Route::Contracts, "metrics" => Route::Metrics, "query" => Route::Query, "history" => Route::History,
            "fields" => Route::Fields, "audit" => Route::Audit, "library" => Route::Library, "runs" => Route::Runs, "run" => Route::Run(arg?.to_string()),
            "notifications" => Route::Notifications, "destinations" => Route::Destinations, _ => return None,
        })
    }
}

/// Navigation: label, route and the permission that makes the view useful.
pub const NAV: &[(&str, &str, &str)] = &[
    ("Overview", "overview", "report:read"),
    ("Exceptions", "exceptions", "report:read"),
    ("Records", "records", "record:read"),
    ("Lineage", "lineage", "lineage:read"),
    ("Query workspace", "query", "query:propose"),
    ("Query history", "history", "query:history"),
    ("Saved queries", "library", "saved_query:read"),
    ("Run history", "runs", "saved_query:read"),
    ("Notifications", "notifications", "notification:read"),
    ("Delivery", "destinations", "delivery:manage"),
    ("Field policies", "fields", "policy:read"),
    ("Contracts", "contracts", "contract:read"),
    ("Metric definitions", "metrics", "report:read"),
    ("Audit", "audit", "audit:read"),
];

#[derive(Default)]
struct Views {
    overview: Option<Entity<OverviewView>>,
    batch: Option<Entity<BatchView>>,
    exceptions: Option<Entity<ExceptionsView>>,
    records: Option<Entity<RecordsView>>,
    lineage: Option<Entity<LineageView>>,
    contracts: Option<Entity<ContractsView>>,
    metrics: Option<Entity<MetricsView>>,
    query: Option<Entity<QueryView>>,
    history: Option<Entity<HistoryView>>,
    fields: Option<Entity<FieldsView>>,
    audit: Option<Entity<AuditView>>,
    library: Option<Entity<LibraryView>>,
    runs: Option<Entity<RunsView>>,
    run: Option<Entity<RunView>>,
    notifications: Option<Entity<NotificationsView>>,
    destinations: Option<Entity<DestinationsView>>,
}

/// What every view needs: the session and a handle back to the shell (navigation, expiry).
#[derive(Clone)]
pub struct Ctx {
    pub session: Session,
    pub shell: WeakEntity<Shell>,
}

impl Ctx {
    pub fn tenant(&self) -> String { self.session.tenant().unwrap_or_default().to_string() }
    pub fn client(&self) -> clearline_client::Client { self.session.client.clone() }
    pub fn can(&self, p: &str) -> bool { self.session.can(p) }
}

pub struct Shell {
    base_url: String,
    pub session: Option<Session>,
    pub route: Route,
    signin: Entity<SignInView>,
    views: Views,
    notice: Option<(Tone, String)>,
    pub dark: bool,
    pub perf: Perf,
}

pub fn brand(color: Hsla, _cx: &App) -> gpui::Div {
    // The Clearline mark: three rules, the middle one short.
    let rule = |w: f32| div().w(px(w)).h(px(3.)).bg(color);
    h_flex().gap_2().items_center()
        .child(v_flex().gap(px(2.)).child(rule(20.)).child(rule(14.)).child(rule(20.)))
        .child(div().text_lg().font_weight(FontWeight::BOLD).text_color(color).child("Clearline"))
}

impl Shell {
    pub fn new(base_url: String, dark: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let weak = cx.entity().downgrade();
        let signin = cx.new(|cx| SignInView::new(weak, &base_url, window, cx));
        Shell { base_url, session: None, route: Route::Overview, signin, views: Views::default(), notice: None, dark, perf: Perf::default() }
    }

    pub fn signin_view(&self) -> &Entity<SignInView> { &self.signin }

    pub fn signed_in(&mut self, session: Session, cx: &mut Context<Self>) {
        self.notice = None;
        self.views = Views::default();
        self.route = if session.can("report:read") { Route::Overview } else if session.can("contract:read") { Route::Contracts } else { Route::Overview };
        self.session = Some(session);
        // Create the first view now (not lazily on first render) so its loads start immediately.
        if let Some(c) = self.ctx(cx) {
            match self.route {
                Route::Overview => self.views.overview = Some(cx.new(|cx| OverviewView::new(c, cx))),
                Route::Contracts => self.views.contracts = Some(cx.new(|cx| ContractsView::new(c, cx))),
                _ => {}
            }
        }
        cx.notify();
    }

    /// Sign out: drop the session and every view (and with them all loaded data and in-flight requests).
    pub fn sign_out(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.session = None;
        self.views = Views::default();
        let weak = cx.entity().downgrade();
        let url = self.base_url.clone();
        self.signin = cx.new(|cx| SignInView::new(weak, &url, window, cx));
        cx.notify();
    }

    /// Any request answered 401 ends the session; the user signs in again.
    pub fn session_expired(&mut self, message: String, cx: &mut Context<Self>) {
        if self.session.is_none() { return; }
        self.session = None;
        self.views = Views::default();
        self.notice = Some((Tone::Warn, format!("Your session ended: {message}")));
        let msg = self.notice.as_ref().map(|n| n.1.clone());
        self.signin.update(cx, |s, cx| s.set_error(msg, cx));
        cx.notify();
    }

    pub fn toggle_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dark = !self.dark;
        theme::apply(self.dark, Some(window), cx);
        cx.refresh_windows();
        cx.notify();
    }

    pub fn ctx(&self, cx: &Context<Self>) -> Option<Ctx> {
        self.session.clone().map(|session| Ctx { session, shell: cx.entity().downgrade() })
    }

    pub fn navigate(&mut self, route: Route, window: &mut Window, cx: &mut Context<Self>) {
        let Some(c) = self.ctx(cx) else { return };
        match &route {
            Route::Overview => { if self.views.overview.is_none() { self.views.overview = Some(cx.new(|cx| OverviewView::new(c, cx))); } }
            Route::Batch(id) => {
                let id = id.clone();
                match &self.views.batch {
                    Some(b) => b.update(cx, |b, cx| b.open(id, cx)),
                    None => self.views.batch = Some(cx.new(|cx| BatchView::new(c, id, cx))),
                }
            }
            Route::Exceptions => { if self.views.exceptions.is_none() { self.views.exceptions = Some(cx.new(|cx| ExceptionsView::new(c, cx))); } }
            Route::Records => { if self.views.records.is_none() { self.views.records = Some(cx.new(|cx| RecordsView::new(c, window, cx))); } }
            Route::Lineage => { if self.views.lineage.is_none() { self.views.lineage = Some(cx.new(|cx| LineageView::new(c, window, cx))); } }
            Route::Contracts => { if self.views.contracts.is_none() { self.views.contracts = Some(cx.new(|cx| ContractsView::new(c, cx))); } }
            Route::Metrics => { if self.views.metrics.is_none() { self.views.metrics = Some(cx.new(|cx| MetricsView::new(c, cx))); } }
            Route::Query => { if self.views.query.is_none() { self.views.query = Some(cx.new(|cx| QueryView::new(c, window, cx))); } }
            Route::History => {
                match &self.views.history { Some(h) => h.update(cx, |h, cx| h.reload(cx)), None => self.views.history = Some(cx.new(|cx| HistoryView::new(c, cx))) }
            }
            Route::Fields => { if self.views.fields.is_none() { self.views.fields = Some(cx.new(|cx| FieldsView::new(c, window, cx))); } }
            Route::Audit => {
                match &self.views.audit { Some(a) => a.update(cx, |a, cx| a.reload(cx)), None => self.views.audit = Some(cx.new(|cx| AuditView::new(c, window, cx))) }
            }
            Route::Library => { if self.views.library.is_none() { self.views.library = Some(cx.new(|cx| LibraryView::new(c, window, cx))); } }
            Route::Runs => { match &self.views.runs { Some(r) => r.update(cx, |r, cx| r.reload(cx)), None => self.views.runs = Some(cx.new(|cx| RunsView::new(c, cx))) } }
            Route::Run(id) => {
                let id = id.clone();
                match &self.views.run { Some(r) => r.update(cx, |r, cx| r.open(id, cx)), None => self.views.run = Some(cx.new(|cx| RunView::new(c, id, window, cx))) }
            }
            Route::Notifications => { match &self.views.notifications { Some(n) => n.update(cx, |n, cx| n.reload(cx)), None => self.views.notifications = Some(cx.new(|cx| NotificationsView::new(c, cx))) } }
            Route::Destinations => { match &self.views.destinations { Some(d) => d.update(cx, |d, cx| d.reload(cx)), None => self.views.destinations = Some(cx.new(|cx| DestinationsView::new(c, window, cx))) } }
        }
        self.route = route;
        cx.notify();
    }

    /// Open a lineage key (from records, exceptions or a query result).
    pub fn open_lineage(&mut self, entity: String, key: String, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate(Route::Lineage, window, cx);
        if let Some(l) = &self.views.lineage { l.update(cx, |l, cx| l.lookup(entity, key, window, cx)); }
    }

    /// Open SQL from history in the workspace (as a new, edited proposal).
    pub fn open_in_workspace(&mut self, sql: String, parent: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate(Route::Query, window, cx);
        if let Some(q) = &self.views.query { q.update(cx, |q, cx| q.load_sql(sql, parent, window, cx)); }
    }

    /// Open a saved query in the library (from a run, a notification or the workspace).
    pub fn open_saved_query(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        self.navigate(Route::Library, window, cx);
        if let Some(l) = &self.views.library { l.update(cx, |l, cx| { l.select(id, cx); l.reload(cx); }); }
    }

    /// After a policy change, views that show field values must re-fetch under the new policy.
    pub fn policy_changed(&mut self, cx: &mut Context<Self>) {
        if let Some(q) = &self.views.query { q.update(cx, |q, cx| q.policy_changed(cx)); }
        if let Some(r) = &self.views.records { r.update(cx, |r, cx| r.reload(cx)); }
        if let Some(h) = &self.views.history { h.update(cx, |h, cx| h.reload(cx)); }
        if let Some(l) = &self.views.library { l.update(cx, |l, cx| l.refresh_selected(cx)); }
        if let Some(r) = &self.views.run { r.update(cx, |r, cx| r.reload(cx)); }
        self.views.lineage = None;
        self.views.exceptions = None;
        self.views.batch = None;
    }

    pub fn visible_nav(&self) -> Vec<(&'static str, &'static str)> {
        let Some(s) = &self.session else { return vec![] };
        NAV.iter().filter(|(_, _, perm)| s.can(perm)).map(|(l, r, _)| (*l, *r)).collect()
    }

    // ---- automation access (src/automation.rs)
    pub fn query_view(&self) -> Option<&Entity<QueryView>> { self.views.query.as_ref() }
    pub fn fields_view(&self) -> Option<&Entity<FieldsView>> { self.views.fields.as_ref() }
    pub fn records_view(&self) -> Option<&Entity<RecordsView>> { self.views.records.as_ref() }
    pub fn history_view(&self) -> Option<&Entity<HistoryView>> { self.views.history.as_ref() }
    pub fn library_view(&self) -> Option<&Entity<LibraryView>> { self.views.library.as_ref() }
    pub fn run_view(&self) -> Option<&Entity<RunView>> { self.views.run.as_ref() }
    pub fn runs_view(&self) -> Option<&Entity<RunsView>> { self.views.runs.as_ref() }
    pub fn notifications_view(&self) -> Option<&Entity<NotificationsView>> { self.views.notifications.as_ref() }
    pub fn destinations_view(&self) -> Option<&Entity<DestinationsView>> { self.views.destinations.as_ref() }

    pub fn busy(&self, cx: &App) -> bool {
        if self.signin.read(cx).busy { return true; }
        let v = &self.views;
        v.overview.as_ref().is_some_and(|x| x.read(cx).busy()) || v.batch.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.exceptions.as_ref().is_some_and(|x| x.read(cx).busy()) || v.records.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.lineage.as_ref().is_some_and(|x| x.read(cx).busy()) || v.contracts.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.metrics.as_ref().is_some_and(|x| x.read(cx).busy()) || v.query.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.history.as_ref().is_some_and(|x| x.read(cx).busy()) || v.fields.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.audit.as_ref().is_some_and(|x| x.read(cx).busy()) || v.library.as_ref().is_some_and(|x| x.read(cx).busy() || x.read(cx).analysis_builder.read(cx).busy() || x.read(cx).schedule_editor.read(cx).busy())
            || v.runs.as_ref().is_some_and(|x| x.read(cx).busy()) || v.run.as_ref().is_some_and(|x| x.read(cx).busy())
            || v.notifications.as_ref().is_some_and(|x| x.read(cx).busy()) || v.destinations.as_ref().is_some_and(|x| x.read(cx).busy())
    }

    /// What the window currently shows, as data (for the automated end-to-end tests).
    pub fn snapshot(&self, cx: &App) -> Value {
        let Some(s) = &self.session else { return json!({ "signed_in": false, "sign_in": self.signin.read(cx).snapshot(), "theme": if self.dark { "dark" } else { "light" } }) };
        let v = &self.views;
        let view = match &self.route {
            Route::Overview => v.overview.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Batch(_) => v.batch.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Exceptions => v.exceptions.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Records => v.records.as_ref().map(|x| x.read(cx).snapshot(cx)),
            Route::Lineage => v.lineage.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Contracts => v.contracts.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Metrics => v.metrics.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Query => v.query.as_ref().map(|x| x.read(cx).snapshot(cx)),
            Route::History => v.history.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Fields => v.fields.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Audit => v.audit.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Library => v.library.as_ref().map(|x| x.read(cx).snapshot(cx)),
            Route::Runs => v.runs.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Run(_) => v.run.as_ref().map(|x| x.read(cx).snapshot(cx)),
            Route::Notifications => v.notifications.as_ref().map(|x| x.read(cx).snapshot()),
            Route::Destinations => v.destinations.as_ref().map(|x| x.read(cx).snapshot(cx)),
        };
        json!({ "signed_in": true, "actor": s.me.actor, "tenant": s.me.tenant_id, "role": s.me.role, "route": self.route.id(),
            "nav": self.visible_nav().iter().map(|(l, _)| l).collect::<Vec<_>>(), "theme": if self.dark { "dark" } else { "light" }, "view": view })
    }

    fn rail(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        let s = self.session.as_ref().expect("rail is shown only when signed in");
        let current = self.route.id();
        let items: Vec<AnyElement> = self.visible_nav().into_iter().map(|(label, id)| {
            let active = current == id || (id == "overview" && current == "batch") || (id == "runs" && current == "run");
            let unread = if id == "notifications" { self.views.notifications.as_ref().map(|n| n.read(cx).unread()).unwrap_or(0) } else { 0 };
            let label = if unread > 0 { format!("{label} ({unread})") } else { label.to_string() };
            let route_id: SharedString = id.into();
            div().id(route_id.clone()).px_3().py(px(7.)).rounded(px(3.)).border_l_4().cursor_pointer()
                .border_color(if active { p.rail_ink } else { gpui::transparent_black() })
                .when(active, |d| d.bg(p.rail_active).font_weight(FontWeight::SEMIBOLD))
                .hover(|d| d.bg(p.rail_active))
                .text_color(p.rail_ink).text_sm().child(label)
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(r) = Route::parse(&route_id, None) { this.navigate(r, window, cx); }
                }))
                .into_any_element()
        }).collect();
        v_flex().w(px(228.)).h_full().flex_none().bg(p.rail).p_4().gap_4()
            .child(brand(p.rail_ink, cx))
            .child(v_flex().text_sm()
                .child(div().font_weight(FontWeight::BOLD).text_color(p.rail_ink).child(s.me.tenant_id.clone().unwrap_or_else(|| "platform".into())))
                .child(div().text_color(p.rail_muted).child(format!("{}, {}", s.me.actor, s.me.role))))
            .child(v_flex().gap(px(2.)).children(items))
            .child(div().flex_1())
            .child(div().id("theme-toggle").text_sm().text_color(p.rail_muted).cursor_pointer().hover(|d| d.text_color(p.rail_ink))
                .child(if self.dark { "Light theme" } else { "Dark theme" }).on_click(cx.listener(|this, _, window, cx| this.toggle_theme(window, cx))))
            .child(div().id("sign-out").text_sm().text_color(p.rail_muted).cursor_pointer().hover(|d| d.text_color(p.rail_ink))
                .child("Sign out").on_click(cx.listener(|this, _, window, cx| this.sign_out(window, cx))))
            .child(div().text_xs().text_color(p.rail_muted).child("Synthetic data only. Not for real member information."))
    }

    fn content(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = pal(cx);
        let s = self.session.as_ref().unwrap();
        if s.me.tenant_id.is_none() {
            return v_flex().p_8().gap_3().child(div().text_2xl().font_weight(FontWeight::BOLD).text_color(p.ink).child("Platform administrator"))
                .child(ui::note(Tone::Idle, "This token can create tenants and issue tokens through the API, but by design it has no access to tenant data. Sign in with a tenant token to use Clearline.", cx))
                .into_any_element();
        }
        // Make sure the routed view exists (first render after sign-in).
        let needs = match &self.route {
            Route::Overview => self.views.overview.is_none(), Route::Batch(_) => self.views.batch.is_none(), Route::Exceptions => self.views.exceptions.is_none(),
            Route::Records => self.views.records.is_none(), Route::Lineage => self.views.lineage.is_none(), Route::Contracts => self.views.contracts.is_none(),
            Route::Metrics => self.views.metrics.is_none(), Route::Query => self.views.query.is_none(), Route::History => self.views.history.is_none(),
            Route::Fields => self.views.fields.is_none(), Route::Audit => self.views.audit.is_none(), Route::Library => self.views.library.is_none(),
            Route::Runs => self.views.runs.is_none(), Route::Run(_) => self.views.run.is_none(), Route::Notifications => self.views.notifications.is_none(),
            Route::Destinations => self.views.destinations.is_none(),
        };
        if needs { let r = self.route.clone(); self.navigate(r, window, cx); }
        let v = &self.views;
        match &self.route {
            Route::Overview => v.overview.clone().unwrap().into_any_element(),
            Route::Batch(_) => v.batch.clone().unwrap().into_any_element(),
            Route::Exceptions => v.exceptions.clone().unwrap().into_any_element(),
            Route::Records => v.records.clone().unwrap().into_any_element(),
            Route::Lineage => v.lineage.clone().unwrap().into_any_element(),
            Route::Contracts => v.contracts.clone().unwrap().into_any_element(),
            Route::Metrics => v.metrics.clone().unwrap().into_any_element(),
            Route::Query => v.query.clone().unwrap().into_any_element(),
            Route::History => v.history.clone().unwrap().into_any_element(),
            Route::Fields => v.fields.clone().unwrap().into_any_element(),
            Route::Audit => v.audit.clone().unwrap().into_any_element(),
            Route::Library => v.library.clone().unwrap().into_any_element(),
            Route::Runs => v.runs.clone().unwrap().into_any_element(),
            Route::Run(_) => v.run.clone().unwrap().into_any_element(),
            Route::Notifications => v.notifications.clone().unwrap().into_any_element(),
            Route::Destinations => v.destinations.clone().unwrap().into_any_element(),
        }
    }
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.perf.first_frame(window);
        let p: Palette = pal(cx);
        let root = div().size_full().bg(p.paper).text_color(p.ink).font_family("Inter");
        if self.session.is_none() {
            return root.child(self.signin.clone()).into_any_element();
        }
        let content = self.content(window, cx);
        root.child(h_flex().size_full().items_start()
            .child(self.rail(cx))
            .child(div().id("content").flex_1().h_full().overflow_hidden().child(content)))
            .into_any_element()
    }
}
