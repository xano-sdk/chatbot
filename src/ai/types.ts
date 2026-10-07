/**
 * The AI actions' wire types: what each `ai/*` endpoint returns. Plain types, so a frontend imports them
 * for free (`@xano-sdk/chatbot/react` re-exports them).
 *
 * Bump {@link AI_CONTRACT} only when a route, an input or one of these shapes changes in a way the
 * frontend relies on. `GET ai/info` returns it and the React parts check it.
 */
export const AI_CONTRACT = 1;

export type AiFieldKind = "text" | "enum" | "int" | "decimal" | "bool" | "date";
export type AiActionName = "summarise" | "draft" | "extract";

/** A field AI may write, as `GET ai/info` describes it. */
export interface AiFieldInfo {
  name: string;
  label: string;
  type: AiFieldKind;
  values?: string[];
  min?: number;
  max?: number;
  required: boolean;
}

/** One record type, and what the signed-in person may do with it. */
export interface AiRecordInfo {
  label: string;
  fields: AiFieldInfo[];
  summarise: boolean;
  /** Fields that can be drafted. */
  draft: string[];
  /** Fields that can be filled from pasted text. */
  extract: string[];
  /** Applies are sent for approval instead of written. */
  approval: boolean;
  /** The person's role lets them run AI on these records. */
  read: boolean;
  /** The person's role lets them apply suggestions. */
  write: boolean;
}

/** `GET ai/info`. */
export interface AiInfo {
  contract: number;
  /** False: there's no model (no provider key). The UI says "AI isn't connected". */
  connected: boolean;
  /** "stub": deterministic test answers (local engine, tests). "model": a real model. */
  provider: "stub" | "model";
  /** Runs per window per person, and how many this person has used. `max` 0: no limit. */
  limit: { max: number; ttl: number; used: number };
  /** The most characters extract takes. */
  paste_limit: number;
  /** The most characters a draft instruction takes. */
  instruction_limit: number;
  records: Record<string, AiRecordInfo>;
}

/** A value the model proposed that the server refused, and why, in plain words. */
export interface AiDropped {
  field: string;
  value: string;
  reason: string;
}

/** `POST ai/summarise`, `ai/draft`, `ai/extract`. Nothing is written by these. */
export interface AiRunResult {
  action: AiActionName;
  record_type: string;
  record_id: number;
  provider: "stub" | "model";
  /** summarise and draft: the text. */
  text: string;
  /** draft: the field the text is for. */
  field: string;
  /** extract: the proposed values that passed validation, by field. */
  values: Record<string, unknown>;
  /** extract: what the server refused. */
  dropped: AiDropped[];
  /** draft and extract: the record's current values of the writable fields, for a diff. */
  current: Record<string, unknown>;
  /** Set when the answer couldn't be used at all (e.g. the model's reply wasn't readable). */
  problem: string;
}

/** `POST ai/apply`. "applied": written now. "pending": sent for approval (nothing written yet). */
export type AiApplyResult =
  | { status: "applied"; applied: string[]; record: Record<string, unknown>; approval_id: null }
  | { status: "pending"; applied: string[]; record: null; approval_id: number };

/** One row of `GET ai/usage` — the person's own recent AI use. */
export interface AiUsageEntry {
  id: number;
  created_at: number;
  action: AiActionName | "apply";
  record_type: string;
  record_id: number;
  field: string;
  status: "started" | "ok" | "failed";
  provider: string;
  chars_in: number;
  chars_out: number;
  dropped: number;
}
