// Response shapes used by several views (mirrors native/crates/clearline-client/src/types.rs). Numbers that may arrive as
// NUMERIC strings are typed `unknown` and formatted by lib/format.

export type Row = Record<string, unknown>;
export interface Issue { code: string; message: string }
export interface Notification { id: string; kind: string; severity: string; created_at: string | null; read_at: string | null; run_id: string | null; query_id: string | null; title: string; body: string; query_name: string | null }
export interface Notifications { unread: number; items: Notification[] }
export interface SchemaColumn { name: string; type: string; masked?: string | null; sensitive?: boolean }
export interface ParamDecl { name: string; type: string; label?: string | null; required?: boolean; default?: unknown; min?: unknown; max?: unknown; allowed?: unknown[] }
