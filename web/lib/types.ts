export type Role = {
  title: string;
  pct: number;
  low: number;
  mid: number;
  high: number;
};

export type SalaryReport = {
  currency?: string;
  location?: string;
  roles: Role[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Parsed report extracted from a fenced JSON block, if present. */
  report?: SalaryReport;
  /** AI-generated banner illustration (data URI) for the report, if any. */
  banner?: string;
  /** True while the assistant is still streaming. */
  streaming?: boolean;
};

/** Tool-call event names emitted by the orchestrator. */
export const PROFILE_TOOLS = new Set([
  "note_person",
  "finalize_person",
]);

/** Estimated full-profile target — used to scale the completeness meter. */
export const PROFILE_TARGET_NOTES = 8;
