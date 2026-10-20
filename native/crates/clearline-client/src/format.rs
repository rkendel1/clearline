//! Presentation-only formatting (the same rules as the former web dashboard):
//! exact values from the API get grouping separators, never rounding or re-derivation.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn group_digits(s: &str) -> String {
    let neg = s.starts_with('-');
    let body = s.trim_start_matches('-');
    let (int, frac) = match body.split_once('.') { Some((i, f)) => (i, Some(f)), None => (body, None) };
    let mut out = String::new();
    for (i, ch) in int.chars().enumerate() {
        if i > 0 && (int.len() - i) % 3 == 0 { out.push(','); }
        out.push(ch);
    }
    format!("{}{}{}", if neg { "−" } else { "" }, out, frac.map(|f| format!(".{f}")).unwrap_or_default())
}

fn numeric(s: &str) -> bool {
    let b = s.trim_start_matches('-');
    !b.is_empty() && b.split('.').count() <= 2 && b.chars().all(|c| c.is_ascii_digit() || c == '.') && !b.starts_with('.') && !b.ends_with('.')
}

/// Format a metric value by its unit. `None` is shown as an em dash.
pub fn format_value(v: Option<&str>, unit: &str) -> String {
    let Some(s) = v.filter(|s| !s.is_empty()) else { return "—".into() };
    match unit {
        "usd" => format!("${}", group_digits(s)),
        "ratio" => s.parse::<f64>().map(|x| format!("{:.2}%", x * 100.0)).unwrap_or_else(|_| s.to_string()),
        _ if numeric(s) => group_digits(s),
        _ => s.to_string(),
    }
}

/// Seconds since the Unix epoch for an ISO-8601 UTC timestamp ("2026-10-19T18:38:12.123Z", "2026-10-19").
pub fn parse_iso(ts: &str) -> Option<i64> {
    let (date, time) = ts.split_once('T').unwrap_or((ts, "00:00:00Z"));
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let t = time.trim_end_matches('Z');
    let t = t.split(['+']).next().unwrap_or(t);
    let mut hms = t.split(':');
    let h = hms.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let mi = hms.next().and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    let se = hms.next().and_then(|x| x.split('.').next()?.parse::<i64>().ok()).unwrap_or(0);
    // Days from civil (Howard Hinnant's algorithm).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + se)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Oct 19, 2026, 18:38 UTC" (the client shows UTC so every user sees the same instant).
pub fn when(ts: Option<&str>) -> String {
    let Some(ts) = ts else { return "—".into() };
    if ts.len() < 10 { return ts.to_string(); }
    let m: usize = ts[5..7].parse().unwrap_or(1);
    let time = ts.get(11..16).map(|t| format!(", {t} UTC")).unwrap_or_default();
    format!("{} {}, {}{}", MONTHS[m.clamp(1, 12) - 1], ts[8..10].trim_start_matches('0'), &ts[0..4], time)
}

pub fn now_epoch() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) }

pub fn ago(ts: Option<&str>, now: i64) -> String {
    let Some(t) = ts.and_then(parse_iso) else { return "never".into() };
    let s = now - t;
    match s {
        _ if s < 90 => format!("{}s ago", s.max(0)),
        _ if s < 5400 => format!("{} min ago", (s as f64 / 60.0).round()),
        _ if s < 172_800 => format!("{} h ago", (s as f64 / 3600.0).round()),
        _ => format!("{} days ago", (s as f64 / 86400.0).round()),
    }
}

pub fn short_id(id: &str) -> &str { id.get(..8).unwrap_or(id) }

/// Display text for a JSON cell value (strings unquoted, null as an em dash).
pub fn cell(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "—".into(),
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn digits_and_units() {
        assert_eq!(group_digits("189670.45"), "189,670.45");
        assert_eq!(group_digits("-1234567"), "−1,234,567");
        assert_eq!(group_digits("12"), "12");
        assert_eq!(format_value(Some("189670.45"), "usd"), "$189,670.45");
        assert_eq!(format_value(Some("0.004"), "ratio"), "0.40%");
        assert_eq!(format_value(None, "count"), "—");
        assert_eq!(format_value(Some("NW0000001"), "count"), "NW0000001");
    }
    #[test]
    fn timestamps() {
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-10-19T18:38:12.123Z"), Some(1_792_435_092));
        assert_eq!(when(Some("2026-10-19T18:38:12.123Z")), "Oct 19, 2026, 18:38 UTC");
        assert_eq!(ago(Some("2026-10-19T18:38:12Z"), 1_792_435_092 + 120), "2 min ago");
        assert_eq!(ago(None, 0), "never");
    }
}
