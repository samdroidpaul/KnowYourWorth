import type { SalaryReport } from "./types";
import { weightedAverages } from "./parseResult";

function escape(cell: string | number): string {
  const s = String(cell);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function reportToCsv(report: SalaryReport): string {
  const cur = report.currency || "";
  const lines: string[] = [];
  lines.push(["Role", "% of week", `Low${cur ? ` (${cur})` : ""}`, `Mid${cur ? ` (${cur})` : ""}`, `High${cur ? ` (${cur})` : ""}`].map(escape).join(","));
  const sorted = [...report.roles].sort((a, b) => b.pct - a.pct);
  for (const r of sorted) {
    lines.push([r.title, r.pct, r.low, r.mid, r.high].map(escape).join(","));
  }
  const avg = weightedAverages(report);
  if (avg) {
    const label =
      avg.totalPct === 100
        ? "Weighted average (by % of week)"
        : "Weighted average (shares normalized)";
    lines.push([label, 100, avg.low, avg.mid, avg.high].map(escape).join(","));
  }
  return lines.join("\n") + "\n";
}

export function downloadCsv(report: SalaryReport) {
  const csv = reportToCsv(report);
  const today = new Date().toISOString().slice(0, 10);
  const filename = `know-your-worth-${today}.csv`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
