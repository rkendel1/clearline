//! One module per view.
pub mod analysis_builder;
pub mod audit;
pub mod batch;
pub mod contracts;
pub mod destinations;
pub mod exceptions;
pub mod fields;
pub mod history;
pub mod library;
pub mod lineage;
pub mod metrics;
pub mod notifications;
pub mod overview;
pub mod query;
pub mod records;
pub mod run;
pub mod runs;
pub mod schedule_editor;
pub mod signin;

use crate::app::Shell;
use gpui::{AsyncWindowContext, Entity};
use serde_json::Value;

fn field<'a>(cmd: &'a Value, k: &str) -> Result<&'a str, String> { cmd.get(k).and_then(Value::as_str).ok_or_else(|| format!("missing string field {k}")) }

/// View-specific automation commands (see src/automation.rs). Each calls the same method a
/// button, chip or input in that view calls.
pub async fn automation_command(shell: &Entity<Shell>, name: &str, cmd: &Value, cx: &mut AsyncWindowContext) -> Result<(), String> {
    let err = |e: anyhow::Error| e.to_string();
    match name {
        "fields.select" => {
            let (e, f) = (field(cmd, "entity")?.to_string(), field(cmd, "field")?.to_string());
            let v = cx.update(|_, cx| shell.read(cx).fields_view().cloned()).map_err(err)?.ok_or("open field policies first")?;
            let ok = cx.update(|window, cx| v.update(cx, |v, cx| v.select(&e, &f, window, cx))).map_err(err)?;
            if !ok { return Err(format!("no field {e}.{f}")); }
        }
        "fields.set" => {
            let v = cx.update(|_, cx| shell.read(cx).fields_view().cloned()).map_err(err)?.ok_or("open field policies first")?;
            let c = cmd.clone();
            cx.update(|window, cx| v.update(cx, |v, cx| {
                if let Some(r) = c.get("reason").and_then(Value::as_str) { v.set_reason(r, window, cx); }
                v.edit(|d| {
                    if let Some(s) = c.get("sensitive").and_then(Value::as_bool) { d.sensitive = s; }
                    if let Some(r) = c.get("redaction").and_then(Value::as_str) { d.redaction = r.to_string(); }
                    if let Some(u) = c.get("unmask_roles").and_then(Value::as_array) { d.unmask = u.iter().filter_map(Value::as_str).map(str::to_string).collect(); }
                    if let Some(a) = c.get("role_access").and_then(Value::as_object) {
                        for (role, level) in a { if let Some(l) = level.as_str() { if l == "full" { d.role_access.remove(role); } else { d.role_access.insert(role.clone(), l.to_string()); } } }
                    }
                }, cx);
            })).map_err(err)?;
        }
        "fields.apply" => {
            let v = cx.update(|_, cx| shell.read(cx).fields_view().cloned()).map_err(err)?.ok_or("open field policies first")?;
            cx.update(|_, cx| v.update(cx, |v, cx| v.apply(cx))).map_err(err)?;
        }
        "records.entity" => {
            let e = field(cmd, "entity")?.to_string();
            let off = cmd.get("offset").and_then(Value::as_u64).unwrap_or(0) as u32;
            let v = cx.update(|_, cx| shell.read(cx).records_view().cloned()).map_err(err)?.ok_or("open records first")?;
            cx.update(|_, cx| v.update(cx, |v, cx| v.open(e, off, cx))).map_err(err)?;
        }
        "lineage.lookup" => {
            let (e, k) = (field(cmd, "entity")?.to_string(), field(cmd, "key")?.to_string());
            cx.update(|window, cx| shell.update(cx, |s, cx| s.open_lineage(e, k, window, cx))).map_err(err)?;
        }
        "history.all" => {
            let all = cmd.get("all").and_then(Value::as_bool).unwrap_or(true);
            let v = cx.update(|_, cx| shell.read(cx).history_view().cloned()).map_err(err)?.ok_or("open query history first")?;
            cx.update(|_, cx| v.update(cx, |v, cx| v.set_all(all, cx))).map_err(err)?;
        }
        "history.open" => {
            let i = cmd.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let v = cx.update(|_, cx| shell.read(cx).history_view().cloned()).map_err(err)?.ok_or("open query history first")?;
            let ok = cx.update(|window, cx| v.update(cx, |v, cx| v.open(i, window, cx))).map_err(err)?;
            if !ok { return Err("that history entry has no SQL to open".into()); }
        }
        // ---- saved analytics (library, schedule editor, analysis builder, runs, notifications, destinations)
        c if c.starts_with("library.") => {
            let v = cx.update(|_, cx| shell.read(cx).library_view().cloned()).map_err(err)?.ok_or("open saved queries first")?;
            let c2 = cmd.clone();
            let name = c.to_string();
            let ok = cx.update(|window, cx| v.update(cx, |l, cx| -> Result<(), String> {
                let st = |k: &str| c2.get(k).and_then(Value::as_str).map(str::to_string).ok_or(format!("missing string field {k}"));
                match name.as_str() {
                    "library.search" => l.set_search(&st("text")?, window, cx),
                    "library.scope" => { let s = st("scope")?; let s: &'static str = crate::views::library::SCOPES.iter().find(|x| x.0 == s).map(|x| x.0).ok_or("unknown scope")?; l.set_scope(s, cx) }
                    "library.sort" => { let s = st("sort")?; let s: &'static str = crate::views::library::SORTS.iter().find(|x| x.0 == s).map(|x| x.0).ok_or("unknown sort")?; l.set_sort(s, cx) }
                    "library.select" => l.select(st("query")?, cx),
                    "library.tab" => l.set_tab(match st("tab")?.as_str() { "sql" => library::Tab::Sql, "schedules" => library::Tab::Schedules, "analyses" => library::Tab::Analyses, _ => library::Tab::Overview }, cx),
                    "library.param" => { if !l.set_param(&st("name")?, &st("value")?, window, cx) { return Err("no such parameter (open the query first)".into()); } }
                    "library.edit_version" => { let g = |k: &str| c2.get(k).and_then(Value::as_str).map(str::to_string); l.set_version_fields(g("sql").as_deref(), g("parameters").as_deref(), g("note").as_deref(), window, cx) }
                    "library.save_version" => l.save_version(cx),
                    "library.run_now" => l.run_now(cx),
                    "library.preview" => l.preview_rows(cx),
                    "library.favorite" => l.toggle_favorite(cx),
                    "library.duplicate" => l.duplicate(cx),
                    "library.archive" => l.set_status("archived", cx),
                    "library.schedule_action" => { let a = st("action")?; let a: &'static str = ["run", "pause", "resume", "cancel"].into_iter().find(|x| *x == a).ok_or("unknown action")?; l.schedule_action(st("schedule")?, a, cx) }
                    _ => return Err(format!("unknown command {name}")),
                }
                Ok(())
            })).map_err(err)?;
            ok?;
        }
        c if c.starts_with("schedule.") => {
            let l = cx.update(|_, cx| shell.read(cx).library_view().cloned()).map_err(err)?.ok_or("open saved queries first")?;
            let v = cx.update(|_, cx| l.read(cx).schedule_editor.clone()).map_err(err)?;
            let (c2, name) = (cmd.clone(), c.to_string());
            let r = cx.update(|window, cx| v.update(cx, |e, cx| -> Result<(), String> {
                match name.as_str() {
                    "schedule.set" => {
                        if let Some(f) = c2.get("frequency").and_then(Value::as_str) { let f: &'static str = schedule_editor::FREQUENCIES.iter().find(|x| **x == f).copied().ok_or("unknown frequency")?; e.set_frequency(f, cx); }
                        for k in ["interval", "at", "month_day", "start_local", "until_local", "timezone", "name"] { if let Some(x) = c2.get(k).and_then(Value::as_str) { e.set_field(k, x, window, cx); } }
                        if let Some(r) = c2.get("run_as_role").and_then(Value::as_str) { e.set_run_as(r, cx); }
                        if let Some(ds) = c2.get("destinations").and_then(Value::as_array) {
                            for d in ds.iter().filter_map(Value::as_str) { let id = e.destination_id(d).ok_or(format!("no destination named {d}"))?; e.toggle_destination(id, cx); }
                        }
                    }
                    "schedule.preview" => e.run_preview(cx),
                    "schedule.create" => e.create(cx),
                    _ => return Err(format!("unknown command {name}")),
                }
                Ok(())
            })).map_err(err)?;
            r?;
        }
        c if c.starts_with("analysis.") => {
            let l = cx.update(|_, cx| shell.read(cx).library_view().cloned()).map_err(err)?.ok_or("open saved queries first")?;
            let v = cx.update(|_, cx| l.read(cx).analysis_builder.clone()).map_err(err)?;
            let (c2, name) = (cmd.clone(), c.to_string());
            let r = cx.update(|window, cx| v.update(cx, |b, cx| -> Result<(), String> {
                match name.as_str() {
                    "analysis.set" => {
                        if let Some(k) = c2.get("type").and_then(Value::as_str) { let k: &'static str = analysis_builder::TYPES.iter().find(|t| t.0 == k).map(|t| t.0).ok_or("unknown type")?; b.set_kind(k, cx); }
                        if let Some(a) = c2.get("algorithm").and_then(Value::as_str) { let a: &'static str = analysis_builder::TYPES.iter().flat_map(|t| t.2.iter()).find(|x| **x == a).copied().ok_or("unknown algorithm")?; b.set_algorithm(a, cx); }
                        if let Some(t) = c2.get("time_column").and_then(Value::as_str) { b.set_time(t.to_string(), cx); }
                        if let Some(cs) = c2.get("columns").and_then(Value::as_array) { for x in cs.iter().filter_map(Value::as_str) { b.toggle_column(x.to_string(), cx); } }
                        if let Some(x) = c2.get("id_column").and_then(Value::as_str) { b.set_id(Some(x.to_string()), cx); }
                        if let Some(x) = c2.get("group_by").and_then(Value::as_str) { b.set_group(Some(x.to_string()), cx); }
                        if let Some(ps) = c2.get("params").and_then(Value::as_object) { for (k, x) in ps { let x = match x { Value::String(s) => s.clone(), o => o.to_string() }; if !b.set_param(k, &x, window, cx) { return Err(format!("unknown parameter {k}")); } } }
                    }
                    "analysis.validate" => b.validate(cx),
                    "analysis.add" => b.add(cx),
                    _ => return Err(format!("unknown command {name}")),
                }
                Ok(())
            })).map_err(err)?;
            r?;
        }
        "run.retry" | "run.rerun" | "run.reload" | "run.name_cluster" | "run.save_names" | "run.scroll" | "run.all_insights" => {
            let v = cx.update(|_, cx| shell.read(cx).run_view().cloned()).map_err(err)?.ok_or("open a run first")?;
            let (c2, name) = (cmd.clone(), name.to_string());
            let r = cx.update(|window, cx| v.update(cx, |r, cx| -> Result<(), String> {
                match name.as_str() {
                    "run.retry" => r.retry(cx),
                    "run.rerun" => r.rerun(window, cx),
                    "run.reload" => r.reload(cx),
                    "run.scroll" => r.scroll_to(c2.get("y").and_then(Value::as_f64).unwrap_or(0.0) as f32, cx),
                    "run.all_insights" => r.show_all_insights(c2.get("on").and_then(Value::as_bool).unwrap_or(true), cx),
                    "run.name_cluster" => { let (k, n) = (field(&c2, "cluster")?, field(&c2, "name")?); if !r.set_cluster_name(k, n, window, cx) { return Err("no such cluster".into()); } }
                    _ => r.save_names(cx),
                }
                Ok(())
            })).map_err(err)?;
            r?;
        }
        "runs.filter" => {
            let st = field(cmd, "status")?.to_string();
            let v = cx.update(|_, cx| shell.read(cx).runs_view().cloned()).map_err(err)?.ok_or("open run history first")?;
            let s: &'static str = runs::FILTERS.iter().find(|x| x.0 == st).map(|x| x.0).ok_or("unknown status filter")?;
            cx.update(|_, cx| v.update(cx, |r, cx| r.set_status(s, cx))).map_err(err)?;
        }
        "notifications.open" => {
            let i = cmd.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            let v = cx.update(|_, cx| shell.read(cx).notifications_view().cloned()).map_err(err)?.ok_or("open notifications first")?;
            let ok = cx.update(|window, cx| v.update(cx, |n, cx| n.open(i, window, cx))).map_err(err)?;
            if !ok { return Err("that notification has no run".into()); }
        }
        c if c.starts_with("destinations.") => {
            let v = cx.update(|_, cx| shell.read(cx).destinations_view().cloned()).map_err(err)?.ok_or("open delivery destinations first")?;
            let (c2, name) = (cmd.clone(), c.to_string());
            let r = cx.update(|window, cx| v.update(cx, |d, cx| -> Result<(), String> {
                match name.as_str() {
                    "destinations.set" => {
                        if let Some(k) = c2.get("kind").and_then(Value::as_str) { let k: &'static str = destinations::KINDS.iter().find(|x| x.0 == k).map(|x| x.0).ok_or("unknown kind")?; d.set_kind(k, cx); }
                        if let Some(n) = c2.get("notify_on").and_then(Value::as_str) { d.notify_on = destinations::NOTIFY.iter().find(|x| **x == n).copied().ok_or("unknown notify_on")?; }
                        if let Some(b) = c2.get("with_csv").and_then(Value::as_bool) { d.with_csv = b; }
                        if let Some(b) = c2.get("include_rows").and_then(Value::as_bool) { d.include_rows = b; }
                        for k in ["name", "target", "secret_ref", "max_attempts"] { if let Some(x) = c2.get(k).and_then(Value::as_str) { d.set_field(k, x, window, cx); } }
                    }
                    "destinations.create" => d.create(cx),
                    "destinations.test" => { let id = d.id_of(field(&c2, "name")?).ok_or("no destination with that name")?; d.test(id, cx); }
                    _ => return Err(format!("unknown command {name}")),
                }
                Ok(())
            })).map_err(err)?;
            r?;
        }
        other => return Err(format!("unknown command {other}")),
    }
    Ok(())
}
