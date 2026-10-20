//! Blocking HTTP client for the Clearline API. Calls are made from background
//! threads by the desktop app (never on the UI thread). Every request carries
//! the bearer token; the server decides tenant, role and what is returned.

use crate::types::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub enum ApiError {
    /// 401: the token is missing, invalid or revoked; the session must end.
    Unauthorized(String),
    /// 403: the role lacks the permission (or the target is another tenant).
    Forbidden { code: String, message: String, details: Option<Value> },
    NotFound(String),
    /// Any other HTTP error, with the server's code and message.
    Http { status: u16, code: String, message: String, correlation_id: Option<String>, details: Option<Value> },
    /// The backend could not be reached or the connection failed mid-request.
    Network(String),
    /// The response did not match the expected shape.
    Decode(String),
}

impl ApiError {
    pub fn is_session_expired(&self) -> bool { matches!(self, ApiError::Unauthorized(_)) }
    pub fn is_network(&self) -> bool { matches!(self, ApiError::Network(_)) }
    pub fn code(&self) -> &str {
        match self {
            ApiError::Unauthorized(_) => "unauthenticated",
            ApiError::Forbidden { code, .. } | ApiError::Http { code, .. } => code,
            ApiError::NotFound(_) => "not_found",
            ApiError::Network(_) => "network",
            ApiError::Decode(_) => "decode",
        }
    }
    /// A message suitable for showing to the user, with a recovery hint.
    pub fn user_message(&self) -> String {
        match self {
            ApiError::Unauthorized(m) => format!("{m}. Sign in again with a valid token."),
            ApiError::Forbidden { message, .. } => format!("{message}. Your role does not allow this."),
            ApiError::NotFound(m) => m.clone(),
            ApiError::Http { message, correlation_id: Some(c), status, .. } if *status >= 500 => format!("{message} (correlation id {c})"),
            ApiError::Http { message, .. } => message.clone(),
            ApiError::Network(m) => format!("Cannot reach the Clearline backend ({m}). Check that it is running, then retry."),
            ApiError::Decode(m) => format!("Unexpected response from the backend: {m}"),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(&self.user_message()) }
}
impl std::error::Error for ApiError {}

pub type Result<T> = std::result::Result<T, ApiError>;

/// One authenticated connection to a Clearline backend. Cheap to clone (shared connection pool).
#[derive(Clone)]
pub struct Client {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.debug_struct("Client").field("base", &self.base).field("token", &"<redacted>").finish() }
}

fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { out.push(b as char) } else { out.push_str(&format!("%{b:02X}")) }
    }
    out
}

impl Client {
    pub fn new(base: impl Into<String>, token: impl Into<String>) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(5)))
            // Long enough for a query at the server's statement timeout plus margin.
            .timeout_global(Some(Duration::from_secs(120)))
            .build()
            .into();
        Client { base: base.into().trim_end_matches('/').to_string(), token: token.into(), agent }
    }

    pub fn base_url(&self) -> &str { &self.base }

    fn decode<T: DeserializeOwned>(&self, mut res: ureq::http::Response<ureq::Body>) -> Result<T> {
        let status = res.status().as_u16();
        let text = res.body_mut().with_config().limit(64 * 1024 * 1024).read_to_string().map_err(|e| ApiError::Network(e.to_string()))?;
        if (200..300).contains(&status) {
            return serde_json::from_str(&text).map_err(|e| ApiError::Decode(e.to_string()));
        }
        Err(error_from(status, &text))
    }

    fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let res = self.agent.get(format!("{}{}", self.base, path)).header("authorization", format!("Bearer {}", self.token)).call().map_err(net)?;
        self.decode(res)
    }

    fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        let res = self.agent.post(format!("{}{}", self.base, path)).header("authorization", format!("Bearer {}", self.token)).send_json(body).map_err(net)?;
        self.decode(res)
    }

    fn t(&self, tenant: &str, rest: &str) -> String { format!("/api/v1/tenants/{}{}", enc(tenant), rest) }

    // ---- identity
    pub fn me(&self) -> Result<Me> { self.get("/api/v1/me") }
    pub fn health(&self) -> Result<Value> { self.get("/readyz").or_else(|e| match e { ApiError::Http { .. } => Ok(Value::Null), other => Err(other) }) }

    // ---- reports and operations
    pub fn operations(&self, tenant: &str) -> Result<OperationsReport> { self.get(&self.t(tenant, "/reports/operations")) }
    pub fn business(&self, tenant: &str) -> Result<BusinessSummary> { self.get(&self.t(tenant, "/reports/business")) }
    pub fn exceptions(&self, tenant: &str) -> Result<ExceptionReport> { self.get(&self.t(tenant, "/reports/exceptions")) }
    pub fn batches(&self, tenant: &str, limit: u32) -> Result<Vec<BatchSummary>> { self.get(&self.t(tenant, &format!("/batches?limit={limit}"))) }
    pub fn batch(&self, tenant: &str, id: &str) -> Result<BatchDetail> { self.get(&self.t(tenant, &format!("/batches/{}", enc(id)))) }
    pub fn findings(&self, tenant: &str, id: &str, rule: &str) -> Result<Vec<Value>> { self.get(&self.t(tenant, &format!("/batches/{}/findings?rule_id={}&limit=500", enc(id), enc(rule)))) }
    pub fn replay(&self, tenant: &str, id: &str) -> Result<Value> { self.post(&self.t(tenant, &format!("/batches/{}/replay", enc(id))), &json!({})) }
    pub fn lineage(&self, tenant: &str, entity: &str, key: &str) -> Result<Lineage> { self.get(&self.t(tenant, &format!("/lineage/{}/{}", enc(entity), enc(key)))) }
    pub fn records(&self, tenant: &str, entity: &str, limit: u32, offset: u32) -> Result<Records> { self.get(&self.t(tenant, &format!("/entities/{}/records?limit={limit}&offset={offset}", enc(entity)))) }

    // ---- contracts and definitions
    pub fn contracts(&self, tenant: &str) -> Result<Vec<ContractVersion>> { self.get(&self.t(tenant, "/contracts")) }
    pub fn active_contract(&self, tenant: &str) -> Result<ActiveContract> { self.get(&self.t(tenant, "/contracts/active")) }
    pub fn migrations(&self, tenant: &str) -> Result<Vec<Migration>> { self.get(&self.t(tenant, "/migrations")) }
    pub fn approve_migration(&self, tenant: &str, id: &str, confirm_version: &str) -> Result<Value> { self.post(&self.t(tenant, &format!("/migrations/{}/approve", enc(id))), &json!({ "confirm_version": confirm_version })) }
    pub fn reject_migration(&self, tenant: &str, id: &str, reason: &str) -> Result<Value> { self.post(&self.t(tenant, &format!("/migrations/{}/reject", enc(id))), &json!({ "reason": reason })) }
    pub fn metric_definitions(&self, tenant: &str) -> Result<MetricDefinitions> { self.get(&self.t(tenant, "/metrics/definitions")) }
    pub fn audit(&self, tenant: &str, action_prefix: Option<&str>, limit: u32) -> Result<Vec<AuditEvent>> {
        let q = action_prefix.map(|a| format!("&action={}", enc(a))).unwrap_or_default();
        self.get(&self.t(tenant, &format!("/audit?limit={limit}{q}")))
    }

    // ---- query workspace
    pub fn catalog(&self, tenant: &str) -> Result<Catalog> { self.get(&self.t(tenant, "/queries/catalog")) }
    pub fn propose_question(&self, tenant: &str, question: &str) -> Result<Proposal> { self.post(&self.t(tenant, "/queries/proposals"), &json!({ "question": question })) }
    pub fn propose_sql(&self, tenant: &str, sql: &str, parent_id: Option<&str>) -> Result<Proposal> {
        self.post(&self.t(tenant, "/queries/proposals"), &json!({ "sql": sql, "parent_id": parent_id }))
    }
    /// Explicit execution of a stored proposal; the server re-validates it first. `execution_id`
    /// (see [`new_execution_id`]) lets the caller cancel the execution while it is still running.
    pub fn execute(&self, tenant: &str, proposal_id: &str, mode: &str, execution_id: Option<&str>) -> Result<ExecuteResult> {
        self.post(&self.t(tenant, &format!("/queries/proposals/{}/execute", enc(proposal_id))), &json!({ "mode": mode, "execution_id": execution_id }))
    }
    pub fn cancel(&self, tenant: &str, execution_id: &str) -> Result<Value> { self.post(&self.t(tenant, &format!("/queries/executions/{}/cancel", enc(execution_id))), &json!({})) }
    pub fn history(&self, tenant: &str, all: bool) -> Result<History> { self.get(&self.t(tenant, &format!("/queries/history?limit=100{}", if all { "&all=true" } else { "" }))) }
    pub fn export_csv(&self, tenant: &str, proposal_id: &str) -> Result<String> {
        let res = self.agent.post(format!("{}{}", self.base, self.t(tenant, &format!("/queries/proposals/{}/export", enc(proposal_id)))))
            .header("authorization", format!("Bearer {}", self.token)).send_json(json!({})).map_err(net)?;
        let status = res.status().as_u16();
        let mut res = res;
        let text = res.body_mut().read_to_string().map_err(|e| ApiError::Network(e.to_string()))?;
        if (200..300).contains(&status) { Ok(text) } else { Err(error_from(status, &text)) }
    }

    // ---- field policy
    pub fn field_policies(&self, tenant: &str) -> Result<FieldPolicies> { self.get(&self.t(tenant, "/fields/policies")) }
    pub fn change_policy(&self, tenant: &str, entity: &str, field: &str, patch: &PolicyPatch) -> Result<PolicyUpdate> {
        self.post(&self.t(tenant, &format!("/fields/{}/{}/policy", enc(entity), enc(field))), &serde_json::to_value(patch).expect("serializable"))
    }
    pub fn policy_history(&self, tenant: &str) -> Result<Vec<PolicyVersion>> { self.get(&self.t(tenant, "/fields/policies/history?limit=500")) }
}

fn net(e: ureq::Error) -> ApiError { ApiError::Network(e.to_string()) }

fn error_from(status: u16, text: &str) -> ApiError {
    let v: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let code = v.pointer("/error/code").and_then(Value::as_str).unwrap_or("http_error").to_string();
    let message = v.pointer("/error/message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
    let details = v.pointer("/error/details").cloned().filter(|d| !d.is_null());
    match status {
        401 => ApiError::Unauthorized(message),
        403 => ApiError::Forbidden { code, message, details },
        404 => ApiError::NotFound(message),
        _ => ApiError::Http { status, code, message, correlation_id: v.get("correlation_id").and_then(Value::as_str).map(str::to_string), details },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn errors_map_to_actionable_kinds() {
        assert!(error_from(401, r#"{"error":{"code":"unauthenticated","message":"Invalid or revoked token"}}"#).is_session_expired());
        let e = error_from(503, r#"{"error":{"code":"provider_unavailable","message":"down","details":{"retryable":true}},"correlation_id":"c1"}"#);
        assert_eq!(e.code(), "provider_unavailable");
        assert_eq!(e.user_message(), "down (correlation id c1)");
        assert_eq!(error_from(502, "<html>").code(), "http_error");
        assert_eq!(enc("a b/ç"), "a%20b%2F%C3%A7");
        let (x, y) = (new_execution_id(), new_execution_id());
        assert_ne!(x, y);
        assert_eq!(x.len(), 36);
        assert_eq!(&x[14..15], "4");
    }
}

/// A random-looking UUID (v4 layout) for naming an execution before it starts. Uniqueness, not
/// secrecy, is what matters: the server rejects a duplicate and only the owner may cancel.
pub fn new_execution_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0)
        ^ (std::process::id() as u64).rotate_left(32) ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut next = || { x = x.wrapping_add(0x9E37_79B9_7F4A_7C15); let mut z = x; z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9); z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB); z ^ (z >> 31) };
    let (a, b) = (next(), next());
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_be_bytes());
    bytes[8..].copy_from_slice(&b.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}
