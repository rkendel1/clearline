//! Clearline native desktop client.
//!
//!   clearline [--url http://localhost:8080] [--theme light|dark] [--size 1400x900] [--automation]
//!
//! Environment: CLEARLINE_URL, CLEARLINE_THEME; CLEARLINE_TOKEN signs in at startup
//! (development convenience: prefer typing the token, so it never sits in the environment).
//! `--automation` reads JSON commands on stdin and answers on stdout (test/e2e/native.test.ts).

mod app;
mod automation;
mod chart;
mod data;
mod grid;
mod perf;
mod theme;
mod ui;
mod views;

use gpui::{px, size, App, AppContext, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions};
use gpui_component::highlighter::{LanguageConfig, LanguageRegistry};
use gpui_component::Root;

struct Args { url: String, dark: bool, width: f32, height: f32, automation: bool }

fn args() -> Args {
    let mut a = Args {
        url: std::env::var("CLEARLINE_URL").unwrap_or_else(|_| "http://localhost:8080".into()),
        dark: std::env::var("CLEARLINE_THEME").map(|t| t == "dark").unwrap_or(false),
        width: 1440.0, height: 920.0, automation: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--url" => a.url = it.next().expect("--url needs a value"),
            "--theme" => a.dark = it.next().as_deref() == Some("dark"),
            "--size" => {
                let v = it.next().expect("--size needs WxH");
                let (w, h) = v.split_once('x').expect("--size WxH");
                a.width = w.parse().expect("width"); a.height = h.parse().expect("height");
            }
            "--automation" => a.automation = true,
            "--help" | "-h" => { println!("clearline [--url URL] [--theme light|dark] [--size WxH] [--automation]"); std::process::exit(0); }
            other => { eprintln!("unknown argument {other}"); std::process::exit(2); }
        }
    }
    a
}

fn main() {
    perf::mark_process_start();
    let a = args();
    // SQL highlighting for the proposal editor (tree-sitter grammar registered once).
    LanguageRegistry::singleton().register("sql", &LanguageConfig::new("sql", tree_sitter_sequel::LANGUAGE.into(), vec![], tree_sitter_sequel::HIGHLIGHTS_QUERY, "", ""));
    Application::new().run(move |cx: &mut App| {
        gpui_component::init(cx);
        theme::apply(a.dark, None, cx);
        let bounds = Bounds::centered(None, size(px(a.width), px(a.height)), cx);
        let opts = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("Clearline".into()), ..Default::default() }),
            ..Default::default()
        };
        let url = a.url.clone();
        let dark = a.dark;
        let automation = a.automation;
        let window = cx.open_window(opts, move |window, cx| {
            let shell = cx.new(|cx| app::Shell::new(url, dark, window, cx));
            if let Ok(token) = std::env::var("CLEARLINE_TOKEN") {
                let signin = shell.read(cx).signin_view().clone();
                signin.update(cx, |s, cx| { s.token.update(cx, |t, cx| t.set_value(token, window, cx)); s.submit(window, cx); });
            }
            if automation { automation::start(shell.clone(), window, cx); }
            cx.new(|cx| Root::new(shell, window, cx))
        }).expect("open window");
        let _ = window;
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        cx.activate(true);
    });
}
