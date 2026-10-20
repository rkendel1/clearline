// Natural-language-to-SQL provider interface. A provider receives the question
// and the PERMITTED catalog for the requesting role (metadata only: names,
// types, descriptions, access levels, relationships, metric definitions; never
// row values) and returns an UNTRUSTED proposal. Nothing a provider returns is
// executed or trusted: the SQL goes through src/query/validate.ts like any
// hand-written query, and the explanation is shown labelled as model output.

import type { catalogJson } from '../catalog.js';

export interface ProviderRequest {
  question: string;
  catalog: ReturnType<typeof catalogJson>;
  dialect: 'postgresql';
  /** ISO date the request is evaluated on, so relative periods are explicit. */
  today: string;
}

export type ProviderResult =
  | { kind: 'proposal'; sql: string; explanation: string; assumptions: string[] }
  | { kind: 'cannot_answer'; explanation: string };

export interface SqlProvider {
  readonly id: string;
  readonly model: string | null;
  generate(req: ProviderRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

/** Thrown when the configured provider cannot be reached or answered unusably; maps to HTTP 503. */
export class ProviderUnavailable extends Error {
  constructor(readonly provider: string, message: string, readonly retryable: boolean) { super(message); }
}
