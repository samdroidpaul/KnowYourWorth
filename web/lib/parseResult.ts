import type { SalaryReport, Role } from "./types";

const FENCE_RE = /```json\s*([\s\S]*?)```/gi;

function isRole(x: unknown): x is Role {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.title === "string" &&
    typeof r.pct === "number" &&
    typeof r.low === "number" &&
    typeof r.mid === "number" &&
    typeof r.high === "number"
  );
}

/**
 * Scan a (possibly partial) streaming message for a fenced ```json block
 * that contains a `roles` array. Returns the parsed report or null.
 *
 * The agent owns the numbers — we never edit, round, or convert them.
 */
export function extractReport(text: string): SalaryReport | null {
  if (!text) return null;
  const matches = Array.from(text.matchAll(FENCE_RE));
  // Walk newest-last so the most recent fence wins if the agent emits more than one.
  for (let i = matches.length - 1; i >= 0; i--) {
    const raw = matches[i]?.[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed && Array.isArray(parsed.roles) && parsed.roles.every(isRole)) {
        return {
          currency: typeof parsed.currency === "string" ? parsed.currency : undefined,
          location: typeof parsed.location === "string" ? parsed.location : undefined,
          roles: parsed.roles as Role[],
        };
      }
    } catch {
      // Partial / not-yet-closed JSON during streaming — try the next match.
    }
  }
  return null;
}

/**
 * Strip the raw JSON fence from a message so the table doesn't get rendered
 * twice (once as code, once as the dedicated SalaryTable).
 */
export function stripJsonFence(text: string): string {
  return text.replace(FENCE_RE, "").trim();
}

/**
 * Time-weighted blend of the role ranges: each role contributes its salary
 * multiplied by its share of the week. Divides by the pct total so a split
 * that doesn't sum to exactly 100 still averages correctly. Derived from the
 * agent's figures — the roles themselves are never modified.
 */
export function weightedAverages(
  report: SalaryReport
): { low: number; mid: number; high: number; totalPct: number } | null {
  const roles = report.roles;
  if (!roles.length) return null;
  const totalPct = roles.reduce((s, r) => s + r.pct, 0);
  if (totalPct <= 0) return null;
  const blend = (k: "low" | "mid" | "high") =>
    Math.round(roles.reduce((s, r) => s + r[k] * r.pct, 0) / totalPct);
  return { low: blend("low"), mid: blend("mid"), high: blend("high"), totalPct };
}

export function formatMoney(amount: number, currency?: string): string {
  const cur = (currency || "").trim();
  // Use Intl when the currency is a real ISO code; otherwise fall back to a
  // currency-prefix style ("NZD 95,000") matching the brief's example.
  const isIso = /^[A-Z]{3}$/.test(cur);
  if (isIso) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur,
        maximumFractionDigits: 0,
      }).format(amount);
    } catch {
      /* fall through */
    }
  }
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(amount);
  return cur ? `${cur} ${formatted}` : formatted;
}
