//! Sign-in: an API token (masked input) against a backend URL. The token is
//! validated by the server (/api/v1/me) on a background thread and kept in memory only.

use crate::app::Shell;
use crate::ui::{self, pal, Tone};
use clearline_client::Session;
use gpui::{div, prelude::*, px, Context, Entity, FontWeight, Task, WeakEntity, Window};
use gpui_component::{button::{Button, ButtonVariants}, input::{Input, InputEvent, InputState}, v_flex, h_flex};
use serde_json::{json, Value};

pub struct SignInView {
    shell: WeakEntity<Shell>,
    pub token: Entity<InputState>,
    pub url: Entity<InputState>,
    error: Option<String>,
    pub busy: bool,
    task: Option<Task<()>>,
}

impl SignInView {
    pub fn new(shell: WeakEntity<Shell>, base_url: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let token = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("cl_…"));
        let url = cx.new(|cx| InputState::new(window, cx).default_value(base_url.to_string()));
        cx.subscribe_in(&token, window, |this, _, ev: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { .. } = ev { this.submit(window, cx); }
        }).detach();
        token.update(cx, |t, cx| t.focus(window, cx));
        SignInView { shell, token, url, error: None, busy: false, task: None }
    }

    pub fn set_error(&mut self, msg: Option<String>, cx: &mut Context<Self>) { self.error = msg; cx.notify(); }

    pub fn submit(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.busy { return; }
        let token = self.token.read(cx).unmask_value().to_string();
        let url = self.url.read(cx).value().to_string();
        self.busy = true;
        self.error = None;
        let shell = self.shell.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { Session::sign_in(&url, &token) }).await;
            let _ = this.update(cx, |view, cx| {
                view.busy = false;
                match result {
                    Ok(session) => {
                        view.token.update(cx, |_, cx| cx.notify());
                        let _ = shell.update(cx, |s, cx| s.signed_in(session, cx));
                    }
                    Err(e) => view.error = Some(if e.is_session_expired() { "That token is not valid or has been revoked.".into() } else { e.user_message() }),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub fn snapshot(&self) -> Value { json!({ "view": "sign_in", "busy": self.busy, "error": self.error }) }
}

impl Render for SignInView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = pal(cx);
        div().size_full().bg(p.paper).flex().items_center().justify_center().child(
            v_flex().w(px(440.)).gap_3().p_8().bg(p.surface).border_1().border_color(p.rule).rounded(px(6.))
                .child(crate::app::brand(p.ink, cx))
                .child(div().text_2xl().font_weight(FontWeight::BOLD).text_color(p.ink).child("Sign in with an API token"))
                .child(div().text_sm().text_color(p.ink2).child("Your token decides which tenant you see and what you can do. It is kept in memory for this session only."))
                .child(div().text_xs().text_color(p.ink2).child("API token"))
                .child(Input::new(&self.token))
                .child(div().text_xs().text_color(p.ink2).child("Backend"))
                .child(Input::new(&self.url))
                .child(h_flex().child(Button::new("sign-in").primary().label(if self.busy { "Signing in…" } else { "Sign in" }).loading(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))))
                .children(self.error.as_ref().map(|e| ui::note(Tone::Bad, e.clone(), cx)))
                .child(ui::muted("Running the local demo? The seeded demo tokens are listed in the README.", cx)),
        )
    }
}
