// TypeScript view of the canonical contract format. The normative definition
// is contracts/contract.schema.json; these types mirror it.

export type FieldType = 'string' | 'integer' | 'decimal' | 'date' | 'timestamp' | 'boolean' | 'enum';
export type Sensitivity = 'public' | 'internal' | 'pii' | 'phi';
export const SENSITIVE: ReadonlySet<Sensitivity> = new Set(['pii', 'phi']);

export const NAMED_FORMATS = {
  digits: /^[0-9]+$/,
  alnum: /^[A-Za-z0-9]+$/,
  zip5: /^[0-9]{5}$/,
  npi10: /^[0-9]{10}$/,
  ndc11: /^[0-9]{11}$/,
  icd10: /^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/,
  state2: /^[A-Z]{2}$/,
} as const;
export type NamedFormat = keyof typeof NAMED_FORMATS;

export interface FieldDef {
  type: FieldType;
  description?: string;
  required?: boolean;        // the source must supply the field (mapping present + column present)
  nullable?: boolean;        // the value may be null/empty (default true)
  sensitivity?: Sensitivity; // default 'internal'
  precision?: number;        // decimal
  scale?: number;            // decimal
  values?: string[];         // enum
  max_length?: number;       // string
  min?: number | string;     // numeric or ISO date
  max?: number | string;
  format?: NamedFormat;      // string
}

export type CompareOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';

export type Condition =
  | { field: string; op: CompareOp; value: string | number | boolean }
  | { field: string; op: CompareOp; other_field: string }
  | { field: string; op: 'in' | 'not_in'; values: (string | number)[] }
  | { field: string; op: 'is_null' | 'not_null' }
  | { field: string; op: 'not_after_arrival' }       // date/timestamp must not be after batch arrival (deterministic "not in future")
  | { field: string; op: 'within_days_of'; other_field: string; days: number }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface RuleDef {
  id: string;
  description: string;
  severity: 'error' | 'warning';
  when?: Condition;
  assert: Condition;
}

export interface RelationshipDef {
  id: string;
  field: string;
  references: { entity: string; field: string };
  on_missing: 'quarantine' | 'warn';
}

export interface CorrectionDef {
  strategy: 'supersede_by_order' | 'last_arrival_wins' | 'immutable';
  order_by?: string;  // required for supersede_by_order
}

export interface EntityDef {
  description?: string;
  fields: Record<string, FieldDef>;
  key: string[];
  correction: CorrectionDef;
  relationships?: RelationshipDef[];
  rules?: RuleDef[];
  freshness?: { max_age_hours: number };
}

export type TransformOp =
  | { op: 'trim' } | { op: 'upper' } | { op: 'lower' } | { op: 'strip_non_digits' }
  | { op: 'left_pad'; length: number; char: string }
  | { op: 'map_values'; map: Record<string, string>; unmapped: 'keep' | 'null' | 'error' }
  | { op: 'parse_date'; format: 'YYYY-MM-DD' | 'MM/DD/YYYY' | 'YYYYMMDD' }
  | { op: 'parse_timestamp'; format: 'iso8601' }
  | { op: 'parse_decimal'; implied_scale?: number }
  | { op: 'parse_integer' }
  | { op: 'parse_boolean'; true_values: string[]; false_values: string[] }
  | { op: 'default'; value: string };

export interface MappingDef {
  target: string;
  from?: string | string[];     // source column(s); an array is concatenated with `separator`
  separator?: string;
  constant?: string;
  transforms?: TransformOp[];
}

export interface SourceDef {
  description?: string;
  entity: string;
  formats: ('csv' | 'json')[];
  mappings: MappingDef[];
  control_totals?: { sum_fields?: string[] };
  max_processing_seconds?: number;
  sensitive_scan?: { unmapped_columns: 'warn' | 'quarantine'; classified_fields: 'warn' | 'quarantine' };
  max_reject_rate?: number;     // fraction of rows quarantined above which the batch is untrusted (default 0.05)
}

export interface MetricDef {
  id: string;
  title: string;
  description: string;
  entity: string;
  aggregation: 'count' | 'count_distinct' | 'sum' | 'avg';
  field?: string;
  filter?: Condition;
  unit?: 'count' | 'usd' | 'ratio';
}

export interface ExtractDef {
  id: string;
  title: string;
  entity: string;
  fields: string[];
  filterable?: string[];       // fields a caller may filter by (equality / date range)
}

export interface DatasetCheckDef {
  id: string;
  description: string;
  left: { entity: string; aggregation: 'count' | 'sum'; field?: string; filter?: Condition };
  op: CompareOp;
  right: { entity: string; aggregation: 'count' | 'sum'; field?: string; filter?: Condition } | { value: number };
  tolerance?: number;
}

export interface MigrationHints {
  backfill?: Record<string, Record<string, string>>;        // entity -> field -> constant value for existing rows
  value_maps?: Record<string, Record<string, Record<string, string>>>; // entity -> field -> old->new
}

export interface Contract {
  $schema?: string;
  contract_id: string;
  tenant: string;
  version: string;             // semver
  description?: string;
  entities: Record<string, EntityDef>;
  sources: Record<string, SourceDef>;
  outputs: { metrics: MetricDef[]; extracts: ExtractDef[] };
  dataset_checks?: DatasetCheckDef[];
  migration?: MigrationHints;
}
