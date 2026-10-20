//! One module per view.
pub mod audit;
pub mod batch;
pub mod contracts;
pub mod exceptions;
pub mod fields;
pub mod history;
pub mod lineage;
pub mod metrics;
pub mod overview;
pub mod query;
pub mod records;
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
        other => return Err(format!("unknown command {other}")),
    }
    Ok(())
}
