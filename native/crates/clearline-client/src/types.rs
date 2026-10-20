//! Typed views of the Clearline API responses (docs/api.md). These mirror the
//! backend's JSON; they add no business rules. Exact numbers arrive as strings
//! (PostgreSQL NUMERIC) or numbers depending on the column, so numeric display
//! fields are normalised to strings and never re-computed here.

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// A value the API may send as a JSON number or a JSON string, kept as its exact text.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Exact(pub Option<String>);

impl<'de> Deserialize<'de> for Exact {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(Exact(match Value::deserialize(d)? {
            Value::Null => None,
            Value::String(s) => Some(s),
            Value::Number(n) => Some(n.to_string()),
            Value::Bool(b) => Some(b.to_string()),
            other => Some(other.to_string()),
        }))
    }
}

impl Exact {
    pub fn as_str(&self) -> Option<&str> { self.0.as_deref() }
    pub fn as_f64(&self) -> Option<f64> { self.0.as_deref().and_then(|s| s.parse().ok()) }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Me {
    pub actor: String,
    pub tenant_id: Option<String>,
    pub role: String,
    #[serde(default)]
    pub permissions: Vec<String>,
}

// ------------------------------------------------------------------ reports

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Verdict { pub status: String, pub summary: String, #[serde(default)] pub problems: Vec<String> }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Totals {
    pub batches: i64, pub succeeded: i64, pub failed: i64, pub rejected: i64, pub in_flight: i64, pub trusted: i64, pub untrusted: i64,
    pub rows_received: i64, pub rows_accepted: i64, pub rows_quarantined: i64, pub rows_duplicate: i64, pub duplicate_submissions: i64,
    #[serde(default)] pub latency_p50_s: Exact, #[serde(default)] pub latency_p95_s: Exact,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Day { pub day: String, pub batches: i64, pub rows_received: i64, pub rows_quarantined: i64, pub failed: i64, pub untrusted: i64 }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Queue { pub queued: i64, pub processing: i64, #[serde(default)] pub oldest_queued_age_s: Exact }

#[derive(Debug, Clone, Deserialize)]
pub struct Freshness {
    pub source_id: String, pub entity: String, pub last_arrival: Option<String>, pub last_trusted: Option<String>,
    #[serde(default)] pub age_hours: Exact, #[serde(default)] pub max_age_hours: Exact, pub status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckRow { pub check_id: String, pub status: String, pub explanation: String }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ReconSummary { pub batches_failed: i64, #[serde(default)] pub latest_dataset_run: Vec<CheckRow> }

#[derive(Debug, Clone, Deserialize)]
pub struct BatchSummary {
    pub id: String, pub source_id: String, #[serde(default)] pub entity: String, pub status: String, pub trust_status: String,
    #[serde(default)] pub trust_reasons: Vec<String>,
    #[serde(default)] pub received_count: Exact, #[serde(default)] pub accepted_count: Exact, #[serde(default)] pub quarantined_count: Exact,
    #[serde(default)] pub duplicate_count: Exact, #[serde(default)] pub attempt_count: Exact,
    #[serde(default)] pub is_late: bool, pub arrival_at: Option<String>, pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OperationsReport {
    pub tenant: String, pub contract_version: Option<String>, pub verdict: Verdict, pub totals: Totals,
    #[serde(default)] pub daily: Vec<Day>, pub queue: Queue, #[serde(default)] pub freshness: Vec<Freshness>,
    pub reconciliation: ReconSummary, #[serde(default)] pub recent_batches: Vec<BatchSummary>,
    pub window: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FailingCheck { pub check_id: String, pub explanation: String }

#[derive(Debug, Clone, Deserialize)]
pub struct Metric {
    pub id: String, pub title: String, #[serde(default)] pub description: String, #[serde(default)] pub unit: String,
    #[serde(default)] pub value: Exact, #[serde(default)] pub value_including_untrusted: Exact, #[serde(default)] pub untrusted_records_excluded: Exact,
    #[serde(default)] pub dataset_checks_failing: Vec<FailingCheck>, #[serde(default)] pub trusted: bool, #[serde(default)] pub withheld: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExceptionRate { pub received: i64, pub quarantined: i64, pub rate: f64 }

#[derive(Debug, Clone, Deserialize)]
pub struct BusinessSummary { pub tenant: String, pub contract_version: String, pub metrics: Vec<Metric>, pub exception_rate: ExceptionRate }

// ------------------------------------------------------------------ batches, exceptions, lineage, records

/// Batch detail keeps nested evidence (control totals, reconciliation expected/actual) as JSON:
/// it is displayed, never interpreted.
#[derive(Debug, Clone, Deserialize)]
pub struct BatchDetail {
    pub id: String, pub source_id: String, pub entity: String, pub format: String, pub status: String, pub trust_status: String,
    #[serde(default)] pub trust_reasons: Vec<String>, pub contract_version: String, pub transform_version: String, pub payload_digest: String,
    #[serde(default)] pub byte_size: Exact, pub arrival_at: Option<String>, pub completed_at: Option<String>, pub submitted_by: String,
    pub processing_run_id: Option<String>,
    #[serde(flatten)] pub counts: BTreeMap<String, Value>,
    #[serde(default)] pub attempts: Vec<Value>, #[serde(default)] pub submissions: Vec<Value>,
    #[serde(default)] pub quality_results: Vec<Value>, #[serde(default)] pub reconciliation: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Reason { pub rule_id: String, pub message: String }

#[derive(Debug, Clone, Deserialize)]
pub struct Quarantined {
    pub id: Exact, pub batch_id: String, pub source_id: String, pub entity: String, pub record_key: Option<String>, pub category: String,
    pub status: String, pub source_row: Exact, #[serde(default)] pub reasons: Vec<Reason>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Orphan { pub entity: String, pub relationship: String, pub references: String, pub key: Value, pub missing_reference: Value, pub batch_id: String }

#[derive(Debug, Clone, Deserialize)]
pub struct ExceptionReport {
    pub quarantined: Vec<Quarantined>, #[serde(default)] pub orphaned_references: Vec<Orphan>,
    #[serde(default)] pub late_records: Vec<Value>, #[serde(default)] pub batches_requiring_review: Vec<Value>, #[serde(default)] pub summary: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SourceRow {
    pub row_number: Exact, pub row_hash: String, pub disposition: Option<String>, pub payload_retained: bool,
    pub mapped_columns: Option<Map<String, Value>>, #[serde(default)] pub quality_findings: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LineageVersion {
    pub record_id: i64, pub is_current: bool, #[serde(default)] pub is_late: bool, pub loaded_at: Option<String>, pub values: Map<String, Value>,
    pub contract_version: String, pub transform_version: String, pub batch: Map<String, Value>, pub source_row: Option<SourceRow>,
    #[serde(default)] pub metric_contribution: Vec<Value>, #[serde(default)] pub exports: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Lineage {
    pub entity: String, pub key: String, pub active_contract_version: String, pub current_record_id: Option<i64>, pub trusted_record_id: Option<i64>,
    pub versions: Vec<LineageVersion>, #[serde(default)] pub quarantined_submissions: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Records {
    pub entity: String, pub total: i64, pub limit: i64, pub offset: i64, #[serde(default)] pub fields: Vec<String>,
    /// Field -> redaction style, for fields the server returned in redacted form.
    #[serde(default)] pub redacted: BTreeMap<String, String>,
    pub records: Vec<Map<String, Value>>,
}

// ------------------------------------------------------------------ contracts, metrics, audit

#[derive(Debug, Clone, Deserialize)]
pub struct ContractVersion { pub id: Exact, pub version: String, pub lifecycle: String, pub document_hash: String, pub created_by: String, pub created_at: Option<String>, pub activated_at: Option<String> }

#[derive(Debug, Clone, Deserialize)]
pub struct ActiveContract { pub id: Exact, pub version: String, pub transform_version: String, pub document: Value }

#[derive(Debug, Clone, Deserialize)]
pub struct Migration {
    pub id: Exact, pub classification: String, pub status: String, pub requested_by: String, pub approved_by: Option<String>,
    pub from_version: Option<String>, pub to_version: String, pub plan: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MetricDefinitions { pub contract_version: Option<String>, #[serde(default)] pub declared: Vec<Value>, #[serde(default)] pub platform: Vec<Value> }

#[derive(Debug, Clone, Deserialize)]
pub struct AuditEvent { pub id: Exact, pub at: String, pub actor: String, pub role: Option<String>, pub action: String, pub resource: Option<String>, pub outcome: String, pub details: Value }

// ------------------------------------------------------------------ query workspace

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogColumn {
    pub name: String, #[serde(rename = "type")] pub ty: String, pub description: Option<String>, pub access: String,
    #[serde(default)] pub sensitive: bool, #[serde(default)] pub redaction: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CatalogTable { pub name: String, pub kind: String, pub description: String, #[serde(default)] pub key: Vec<String>, pub columns: Vec<CatalogColumn> }

#[derive(Debug, Clone, Deserialize)]
pub struct ColumnRef { pub table: String, pub column: String }

#[derive(Debug, Clone, Deserialize)]
pub struct Relationship { pub from: ColumnRef, pub to: ColumnRef }

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderInfo { pub id: String, pub model: Option<String> }

#[derive(Debug, Clone, Deserialize)]
pub struct Catalog {
    pub tenant: String, pub role: String, pub tables: Vec<CatalogTable>, #[serde(default)] pub relationships: Vec<Relationship>,
    #[serde(default)] pub metrics: Vec<Value>, pub policy_epoch: i64, pub provider: ProviderInfo,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Issue { pub code: String, pub message: String }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ColumnUse { pub table: String, pub column: String, pub access: String, #[serde(default)] pub usages: Vec<String> }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct JoinInfo { #[serde(rename = "type")] pub ty: String, pub tables: Vec<String> }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OutputColumn { pub name: String, pub table: Option<String>, pub column: Option<String>, pub masked: Option<String> }

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Validation {
    pub ok: bool, #[serde(default)] pub issues: Vec<Issue>, #[serde(default)] pub tables: Vec<String>, #[serde(default)] pub columns: Vec<ColumnUse>,
    #[serde(default)] pub joins: Vec<JoinInfo>, #[serde(default)] pub output: Vec<OutputColumn>, #[serde(default)] pub summary: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Estimate { pub cost: f64, pub rows: f64 }

#[derive(Debug, Clone, Deserialize)]
pub struct Proposal {
    pub id: String, pub source: String, pub parent_id: Option<String>, pub question: Option<String>, pub provider: Option<ProviderInfo>,
    pub proposed_sql: Option<String>, pub model_explanation: Option<String>, #[serde(default)] pub assumptions: Vec<String>,
    pub validation: Validation, pub validated_sql: Option<String>, pub estimate: Option<Estimate>, pub executable: bool, pub executed: bool, pub policy_epoch: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ResultColumn { pub name: String, #[serde(rename = "type")] pub ty: String, pub masked: Option<String> }

#[derive(Debug, Clone, Deserialize)]
pub struct ExecuteResult {
    pub execution_id: String, pub proposal_id: String, pub mode: String, pub status: String, pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Value>>, pub row_count: i64, pub truncated: bool, pub duration_ms: i64, pub executed_sql: String, pub executed_sql_sha256: String,
    pub policy_epoch: i64, pub error: Option<Issue>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryExecution {
    pub id: String, pub mode: String, pub status: String, pub row_count: Option<i64>, pub truncated: Option<bool>, pub duration_ms: Option<i64>,
    pub started_at: Option<String>, pub error_code: Option<String>, pub executed_sql: Option<String>, pub policy_epoch: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HistoryItem {
    pub id: String, pub actor: String, pub role: String, pub source: String, pub parent_id: Option<String>, pub created_at: Option<String>, pub status: String,
    pub question: Option<String>, pub proposed_sql: Option<String>, pub validated_sql: Option<String>, pub validation: Value,
    pub policy_epoch: i64, pub current_policy_epoch: i64, pub stale_policy: bool, pub withheld: bool, #[serde(default)] pub executable_now: bool,
    #[serde(default)] pub executions: Vec<HistoryExecution>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct History { pub policy_epoch: i64, pub items: Vec<HistoryItem> }

// ------------------------------------------------------------------ field policy

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct FieldPolicy {
    pub entity: String, pub field: String, pub sensitive: bool, pub redaction: String, pub reason: Option<String>,
    #[serde(default)] pub unmask_roles: Vec<String>, #[serde(default)] pub role_access: BTreeMap<String, String>,
    pub version: i64, pub source: String, pub updated_by: Option<String>, pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyField {
    pub field: String, #[serde(rename = "type")] pub ty: String, pub description: Option<String>, pub contract_sensitivity: String,
    #[serde(default)] pub allowed_redactions: Vec<String>, pub policy: FieldPolicy, pub effective_access: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyEntity { pub entity: String, pub description: Option<String>, pub table_policy: FieldPolicy, pub fields: Vec<PolicyField> }

#[derive(Debug, Clone, Deserialize)]
pub struct FieldPolicies { pub tenant: String, pub contract_version: String, pub policy_epoch: i64, pub roles: Vec<String>, pub entities: Vec<PolicyEntity> }

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyChange { pub kind: String, #[serde(default)] pub loosening: Vec<String>, #[serde(default)] pub tightening: Vec<String> }

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyUpdate { pub policy: FieldPolicy, pub change: PolicyChange, pub policy_epoch: i64, pub effective_access: Option<BTreeMap<String, String>> }

#[derive(Debug, Clone, Deserialize)]
pub struct PolicyVersion { pub id: Exact, pub entity: String, pub field: String, pub version: i64, pub change_kind: String, pub changed_by: String, pub changed_role: String, pub changed_at: String, pub policy: Value, pub previous: Value }

/// A policy change request; only the fields that are set are sent.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PolicyPatch {
    #[serde(skip_serializing_if = "Option::is_none")] pub sensitive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")] pub redaction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] pub unmask_roles: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub role_access: Option<BTreeMap<String, String>>,
}

// ------------------------------------------------------------------ saved analytics (docs/saved-analytics.md)

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunBrief { pub id: String, pub status: String, pub at: Option<String>, pub row_count: Option<i64>, pub duration_ms: Option<i64> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SavedQuerySummary {
    pub id: String, pub name: String, pub description: Option<String>, pub category: Option<String>, #[serde(default)] pub tags: Vec<String>,
    pub owner: String, pub mine: bool, pub sharing: String, pub status: String, pub version: i64, pub favorite: bool, pub updated_at: Option<String>,
    pub needs_revalidation: Option<String>, #[serde(default)] pub analyses: i64, #[serde(default)] pub active_schedules: i64, pub next_run_at: Option<String>,
    pub last_run: Option<RunBrief>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SavedQueryList { pub items: Vec<SavedQuerySummary> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SchemaColumn { pub name: String, #[serde(rename = "type")] pub ty: String, pub masked: Option<String>, #[serde(default)] pub sensitive: bool }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ParamDecl {
    pub name: String, #[serde(rename = "type")] pub ty: String, pub label: Option<String>, #[serde(default = "yes")] pub required: bool,
    #[serde(default)] pub default: Value, #[serde(default)] pub min: Value, #[serde(default)] pub max: Value, #[serde(default)] pub allowed: Vec<Value>,
}
fn yes() -> bool { true }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SavedVersion {
    pub version: i64, pub sql: Option<String>, pub sql_sha256: String, pub question: Option<String>, pub source_proposal_id: Option<String>,
    #[serde(default)] pub parameters: Vec<ParamDecl>, pub output_schema: Option<Vec<SchemaColumn>>, #[serde(default)] pub analyses: Vec<Value>,
    pub change_note: Option<String>, pub created_by: String, pub created_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct VersionBrief { pub version: i64, pub sql_sha256: String, pub change_note: Option<String>, pub created_by: String, pub created_at: Option<String>, #[serde(default)] pub analyses: i64 }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct ScheduleBrief {
    pub id: String, pub name: String, pub status: String, pub rrule: Option<String>, pub start_local: String, pub timezone: String, pub next_run_at: Option<String>,
    pub attention: Option<String>, pub run_as_actor: String, pub run_as_role: String, pub last_run_id: Option<String>, #[serde(default)] pub description: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunRow {
    pub id: String, pub trigger: String, pub status: String, pub query_status: String, pub analysis_status: String, pub delivery_status: String,
    pub failure_class: Option<String>, pub query_version: i64, pub created_at: Option<String>, pub finished_at: Option<String>, #[serde(default)] pub row_count: Value, #[serde(default)] pub timings: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct LatestAnalysis { pub id: String, pub analysis_key: String, pub analysis_type: String, pub algorithm: String, pub algorithm_version: String, pub status: String, pub message: Option<String>, pub created_at: Option<String>, pub run_id: String }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SavedQueryDetail {
    pub id: String, pub name: String, pub description: Option<String>, pub purpose: Option<String>, pub category: Option<String>, pub business_owner: Option<String>,
    #[serde(default)] pub tags: Vec<String>, pub owner: String, pub owner_role: String, pub mine: bool, pub sharing: String, pub status: String, pub favorite: bool,
    pub created_at: Option<String>, pub updated_at: Option<String>, pub needs_revalidation: Option<String>, pub version: i64, pub executable_now: bool, pub withheld: bool,
    #[serde(default)] pub issues: Vec<Issue>, pub current: SavedVersion, #[serde(default)] pub versions: Vec<VersionBrief>, #[serde(default)] pub schedules: Vec<ScheduleBrief>,
    #[serde(default)] pub recent_runs: Vec<RunRow>, #[serde(default)] pub latest_analyses: Vec<LatestAnalysis>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunAs { pub actor: String, pub role: String }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Schedule {
    pub id: String, pub query_id: String, pub name: String, pub status: String, pub rrule: Option<String>, pub start_local: String, pub timezone: String,
    pub until_local: Option<String>, pub description: String, #[serde(default)] pub parameters: Value, pub run_as: RunAs, #[serde(default)] pub destination_ids: Vec<String>,
    pub next_run_at: Option<String>, pub last_run_id: Option<String>, pub attention: Option<String>, pub max_attempts: i64, pub version: i64,
    #[serde(default)] pub upcoming: Vec<String>, #[serde(default)] pub recent_runs: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SchedulePreview { pub rrule: Option<String>, pub description: String, pub next: Vec<String> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Queued { pub run_id: String, pub status: String }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunResultMeta { #[serde(default)] pub columns: Vec<SchemaColumn>, pub row_count: Option<i64>, pub truncated: Option<bool>, pub bytes: Option<i64>, pub schema_changed: Option<String> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Run {
    pub id: String, pub query_id: String, pub query_version: i64, pub schedule_id: Option<String>, pub occurrence_at: Option<String>, pub trigger: String, pub requested_by: String,
    pub run_as: RunAs, pub status: String, pub query_status: String, pub analysis_status: String, pub delivery_status: String, pub failure_class: Option<String>,
    pub error_code: Option<String>, pub error_message: Option<String>, pub attempt: i64, pub max_attempts: i64, #[serde(default)] pub missed_occurrences: i64,
    pub created_at: Option<String>, pub started_at: Option<String>, pub finished_at: Option<String>, #[serde(default)] pub timings: Value, #[serde(default)] pub parameters: Value,
    pub result: Option<RunResultMeta>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunListItem {
    #[serde(flatten)] pub run: Run, pub query_name: String, #[serde(default)] pub deliveries: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunList { pub items: Vec<RunListItem> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct AnalysisRun {
    pub id: String, pub key: String, #[serde(rename = "type")] pub ty: String, pub algorithm: String, pub algorithm_version: String, pub config: Value, pub status: String,
    pub message: Option<String>, #[serde(default)] pub quality: Value, #[serde(default)] pub result: Value, pub input_rows: Option<i64>, #[serde(default)] pub timings: Value,
    #[serde(default)] pub review: Value, #[serde(default)] pub withheld: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Narrative { pub provider: String, pub model: Option<String>, pub text: Option<String> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Insight {
    pub id: String, pub analysis_run_id: Option<String>, pub kind: String, pub severity: String, pub metric: Option<String>, pub title: String, pub body: String,
    #[serde(default)] pub evidence: Value, pub narrative: Option<Narrative>, pub created_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct DeliveryRow {
    pub id: String, pub destination_id: String, pub destination: String, pub kind: String, pub status: String, pub attempts: i64, pub max_attempts: i64,
    pub next_attempt_at: Option<String>, pub last_error_code: Option<String>, pub last_error: Option<String>, pub delivered_at: Option<String>, #[serde(default)] pub attempts_log: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct QueryRef { pub id: String, pub name: String, pub status: String, pub current_version: i64 }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunAccess { pub data: bool, pub reason: Option<String>, #[serde(default)] pub remasked_columns: Vec<String> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunDetail {
    pub run: Run, pub query: QueryRef, pub access: RunAccess, #[serde(default)] pub analyses: Vec<AnalysisRun>, #[serde(default)] pub insights: Vec<Insight>,
    #[serde(default)] pub insights_withheld: i64, #[serde(default)] pub deliveries: Vec<DeliveryRow>, #[serde(default)] pub exports: Vec<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct RunResultPage { pub run_id: String, pub columns: Vec<SchemaColumn>, pub rows: Vec<Vec<Value>>, pub offset: i64, pub limit: i64, pub row_count: i64, pub truncated: bool }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Destination {
    pub id: String, pub name: String, pub kind: String, pub config: Value, pub content: String, pub notify_on: String, pub enabled: bool, pub max_attempts: i64, pub version: i64,
    #[serde(default)] pub secrets: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Destinations { pub items: Vec<Destination> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct TestDelivery { pub destination_id: String, pub kind: String, pub ok: bool, pub code: Option<String>, pub message: Option<String>, pub status: Option<i64> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Notification {
    pub id: String, pub kind: String, pub severity: String, pub created_at: Option<String>, pub read_at: Option<String>, pub run_id: Option<String>, pub query_id: Option<String>,
    pub title: String, pub body: String, #[serde(default)] pub links: Value, pub query_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Notifications { pub unread: i64, pub items: Vec<Notification> }

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct AnalysisCheck { pub ok: bool, pub config: Option<Value>, #[serde(default)] pub issues: Vec<Value>, pub output_schema: Option<Vec<SchemaColumn>> }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SavedExecution {
    pub execution_id: String, pub status: String, pub columns: Vec<ResultColumn>, pub rows: Vec<Vec<Value>>, pub row_count: i64, pub truncated: bool, pub duration_ms: i64,
    pub version: i64, #[serde(default)] pub parameters: Value, pub error: Option<Issue>,
}
