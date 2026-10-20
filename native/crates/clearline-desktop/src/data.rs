//! Asynchronous loading for views. Every API call runs on the background executor;
//! the UI thread only applies results. Starting a new load replaces (and so cancels)
//! the previous task for the same resource, which prevents redundant concurrent
//! requests and out-of-order results. A 401 ends the session via the shell.

use crate::app::Shell;
use clearline_client::{ApiError, Result};
use gpui::{Context, Task, WeakEntity};

#[derive(Default)]
pub enum Load<T> {
    #[default]
    Idle,
    Loading,
    Ready(T),
    Failed(ApiError),
}

impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> { if let Load::Ready(t) = self { Some(t) } else { None } }
    pub fn is_loading(&self) -> bool { matches!(self, Load::Loading) }
    pub fn error(&self) -> Option<&ApiError> { if let Load::Failed(e) = self { Some(e) } else { None } }
}

/// Run `fetch` on the background executor, then `apply` its result on the UI thread.
/// Session expiry (401) is reported to the shell before `apply` runs.
pub fn spawn_fetch<V: 'static, T: Send + 'static>(
    cx: &mut Context<V>,
    shell: WeakEntity<Shell>,
    fetch: impl FnOnce() -> Result<T> + Send + 'static,
    apply: impl FnOnce(&mut V, Result<T>, &mut Context<V>) + 'static,
) -> Task<()> {
    cx.spawn(async move |this, cx| {
        let result = cx.background_executor().spawn(async move { fetch() }).await;
        let _ = this.update(cx, |view, cx| {
            if let Err(e) = &result {
                if e.is_session_expired() {
                    let msg = e.user_message();
                    let _ = shell.update(cx, |s, cx| s.session_expired(msg, cx));
                }
            }
            apply(view, result, cx);
            cx.notify();
        });
    })
}

/// A loadable value plus its in-flight task (dropping the task cancels it).
pub struct Resource<T> {
    pub state: Load<T>,
    task: Option<Task<()>>,
}

impl<T> Default for Resource<T> {
    fn default() -> Self { Resource { state: Load::Idle, task: None } }
}

impl<T: Send + 'static> Resource<T> {
    pub fn busy(&self) -> bool { self.state.is_loading() }

    /// Load into the resource selected by `slot` (a field accessor on the view).
    pub fn load<V: 'static>(&mut self, cx: &mut Context<V>, shell: WeakEntity<Shell>, slot: fn(&mut V) -> &mut Resource<T>, fetch: impl FnOnce() -> Result<T> + Send + 'static) {
        self.state = Load::Loading;
        self.task = Some(spawn_fetch(cx, shell, fetch, move |view, result, _| {
            slot(view).state = match result { Ok(v) => Load::Ready(v), Err(e) => Load::Failed(e) };
        }));
    }

    pub fn ready(&self) -> Option<&T> { self.state.ready() }
}
