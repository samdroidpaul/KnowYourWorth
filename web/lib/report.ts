import type { SalaryReport } from "./types";
import { formatMoney, weightedAverages } from "./parseResult";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap a chart label into at most `maxLines` lines of ~`maxChars` characters,
 * ellipsizing overflow. Multi-location reports carry titles like
 * "Foreperson (Construction Residential) - QLD - Brisbane, Gold Coast and
 * Sunshine Coast" which would otherwise run off the SVG's left edge.
 */
function wrapLabel(s: string, maxChars: number, maxLines: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= maxChars || !cur) {
      cur = candidate;
    } else {
      lines.push(cur);
      if (lines.length === maxLines - 1) {
        const rest = [w, ...words.slice(i + 1)].join(" ");
        lines.push(
          rest.length > maxChars ? rest.slice(0, maxChars - 1).trimEnd() + "…" : rest
        );
        return lines;
      }
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Build a self-contained HTML report: header, the agent's closing summary,
 * an SVG salary-range chart, and the full table. Opens in any browser and
 * prints cleanly to PDF. Numbers come straight from the agent's JSON.
 */
export function buildReportHtml(
  report: SalaryReport,
  summary: string,
  banner?: string | null
): string {
  const sorted = [...report.roles].sort((a, b) => b.pct - a.pct);
  const cur = report.currency;
  const avg = weightedAverages(report);
  const date = new Date().toLocaleDateString("en-NZ", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // --- SVG range chart ---
  const min = Math.min(...sorted.map((r) => r.low));
  const max = Math.max(...sorted.map((r) => r.high));
  const span = max - min || max || 1;
  const lo = Math.max(0, min - span * 0.08);
  const hi = max + span * 0.08;
  const W = 760;
  const GUTTER = 246;
  const RIGHT = 30;
  const ROW = 46;
  const TOP = 16;
  const plotW = W - GUTTER - RIGHT;
  const chartH = TOP + sorted.length * ROW + 36;
  const sx = (v: number) => GUTTER + ((v - lo) / (hi - lo)) * plotW;

  const ticks = Array.from({ length: 5 }, (_, i) => lo + (i / 4) * (hi - lo));
  const gridLines = ticks
    .map((t) => {
      const x = sx(t).toFixed(1);
      return `<line x1="${x}" x2="${x}" y1="${TOP}" y2="${TOP + sorted.length * ROW}" stroke="#dde1ea" stroke-dasharray="2 4"/>
<text x="${x}" y="${TOP + sorted.length * ROW + 22}" text-anchor="middle" class="tick">${esc(formatMoney(Math.round(t), cur))}</text>`;
    })
    .join("\n");

  const bars = sorted
    .map((r, i) => {
      const y = TOP + i * ROW;
      const x1 = sx(r.low);
      const x2 = sx(r.high);
      const xm = sx(r.mid);
      const lines = wrapLabel(`${r.title} · ${r.pct}%`, 37, 3);
      const cy = y + ROW / 2 + 1;
      const lineH = 13;
      const startY = cy - ((lines.length - 1) * lineH) / 2;
      const label = lines
        .map(
          (ln, li) =>
            `<text x="${GUTTER - 14}" y="${startY + li * lineH}" text-anchor="end" dominant-baseline="middle" class="lbl">${esc(ln)}</text>`
        )
        .join("\n");
      return `${label}
<rect x="${x1.toFixed(1)}" y="${y + 11}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="${ROW - 22}" rx="7" fill="url(#g)"/>
<line x1="${xm.toFixed(1)}" x2="${xm.toFixed(1)}" y1="${y + 8}" y2="${y + ROW - 8}" stroke="#0d5038" stroke-width="2.5"/>`;
    })
    .join("\n");

  // --- Table ---
  const rows = sorted
    .map(
      (r) => `<tr>
  <td>${esc(r.title)}</td>
  <td class="num">${r.pct}%</td>
  <td class="num">${esc(formatMoney(r.low, cur))}</td>
  <td class="num strong">${esc(formatMoney(r.mid, cur))}</td>
  <td class="num">${esc(formatMoney(r.high, cur))}</td>
</tr>`
    )
    .join("\n");

  // --- Summary prose (paragraphs) ---
  const paragraphs = summary
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Know Your Worth — Salary Report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #0e1320; background: #ffffff; margin: 0;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 840px; margin: 0 auto; padding: 48px 32px 64px; }
  .page.has-banner { padding-top: 0; }
  .banner {
    width: 100%;
    height: 20vh;
    min-height: 140px;
    max-height: 260px;
    object-fit: cover;
    display: block;
    margin: 0 0 32px;
  }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
  .logo {
    width: 40px; height: 40px; border-radius: 12px; flex: 0 0 auto;
    background: linear-gradient(135deg, #42d894, #0d7c51);
    display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 20px;
  }
  h1 { font-size: 24px; margin: 0; letter-spacing: -0.02em; }
  .sub { color: #5b6577; font-size: 13px; margin-top: 2px; }
  .meta {
    display: flex; flex-wrap: wrap; gap: 24px; margin: 22px 0 8px;
    padding: 14px 18px; border: 1px solid #dde1ea; border-radius: 12px; background: #f7f8fa;
  }
  .meta div { font-size: 13px; }
  .meta .k { color: #5b6577; text-transform: uppercase; letter-spacing: 0.1em; font-size: 10.5px; }
  .meta .v { font-weight: 600; margin-top: 2px; }
  .stats { display: flex; gap: 14px; margin: 14px 0 4px; }
  .stat {
    flex: 1; border: 1px solid #dde1ea; border-radius: 14px; padding: 16px 14px;
    text-align: center; background: #ffffff;
  }
  .stat .k { color: #5b6577; text-transform: uppercase; letter-spacing: 0.12em; font-size: 10.5px; }
  .stat .v { font-size: 21px; font-weight: 800; margin-top: 5px; letter-spacing: -0.01em; }
  .stat.mid { border-color: #0f9c63; background: #effdf6; }
  .stat.mid .v { color: #0d7c51; }
  h2 { font-size: 15px; letter-spacing: 0.12em; text-transform: uppercase; color: #0f9c63; margin: 36px 0 12px; }
  .summary p { line-height: 1.65; font-size: 14.5px; margin: 0 0 12px; }
  svg { width: 100%; height: auto; }
  .lbl { font-size: 12px; font-weight: 600; fill: #2b3344; }
  .tick { font-size: 10.5px; fill: #8b94a8; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.1em; color: #5b6577; padding: 10px 12px; border-bottom: 2px solid #dde1ea; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td { padding: 11px 12px; border-bottom: 1px solid #eef0f4; }
  td.strong { font-weight: 700; }
  tfoot td { border-top: 2px solid #0f9c63; border-bottom: none; font-weight: 700; background: #f4fcf8; }
  tfoot .pct { color: #5b6577; font-weight: 500; font-size: 12px; }
  .note { color: #5b6577; font-size: 12px; margin-top: 10px; }
  footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #dde1ea; color: #8b94a8; font-size: 11.5px; }
  @media print {
    .page { padding: 24px 8px; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="page${banner ? " has-banner" : ""}">
  ${banner ? `<img class="banner" src="${esc(banner)}" alt="Illustration of your main role"/>` : ""}
  <header>
    <div class="logo">K</div>
    <div>
      <h1>Know Your Worth — Salary Report</h1>
      <div class="sub">Supporting information for any salary discussions.</div>
    </div>
  </header>

  <div class="meta">
    <div><div class="k">Date</div><div class="v">${esc(date)}</div></div>
    <div><div class="k">Location</div><div class="v">${esc(report.location || "Not returned")}</div></div>
    <div><div class="k">Currency</div><div class="v">${esc(cur || "Not returned")}</div></div>
    <div><div class="k">Roles assessed</div><div class="v">${sorted.length}</div></div>
  </div>

  ${
    avg
      ? `<h2>Blended market worth</h2>
  <div class="stats">
    <div class="stat"><div class="k">Low</div><div class="v">${esc(formatMoney(avg.low, cur))}</div></div>
    <div class="stat mid"><div class="k">Mid</div><div class="v">${esc(formatMoney(avg.mid, cur))}</div></div>
    <div class="stat"><div class="k">High</div><div class="v">${esc(formatMoney(avg.high, cur))}</div></div>
  </div>
  <div class="note">${
    avg.totalPct === 100
      ? `Weighted by your % of week across all ${sorted.length} roles.`
      : `Share-weighted average across all ${sorted.length} rows, with the listed shares normalized to a full week. Where the same role appears for several locations, this blends across those locations rather than summing them.`
  } Anchor single-figure negotiations at the blended Mid; the blended High is a defensible stretch.</div>`
      : ""
  }

  ${paragraphs ? `<h2>Summary</h2>\n<div class="summary">${paragraphs}</div>` : ""}

  <h2>Salary ranges</h2>
  <svg viewBox="0 0 ${W} ${chartH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Salary range chart">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#42d894" stop-opacity="0.6"/>
        <stop offset="50%" stop-color="#1cbf78"/>
        <stop offset="100%" stop-color="#0d7c51" stop-opacity="0.9"/>
      </linearGradient>
    </defs>
    ${gridLines}
    ${bars}
  </svg>
  <div class="note">Bars span the Low → High range for each role; the dark marker is the Mid estimate.</div>

  <h2>Detail</h2>
  <table>
    <thead>
      <tr><th>Role</th><th class="num">% of week</th><th class="num">Low</th><th class="num">Mid</th><th class="num">High</th></tr>
    </thead>
    <tbody>
${rows}
    </tbody>
    ${
      avg
        ? `<tfoot>
      <tr>
        <td>Weighted average <span class="pct">${avg.totalPct === 100 ? "(by % of week)" : "(shares normalized)"}</span></td>
        <td class="num">100%</td>
        <td class="num">${esc(formatMoney(avg.low, cur))}</td>
        <td class="num strong">${esc(formatMoney(avg.mid, cur))}</td>
        <td class="num">${esc(formatMoney(avg.high, cur))}</td>
      </tr>
    </tfoot>`
        : ""
    }
  </table>
  ${!cur ? `<div class="note">Note: the figure currency wasn't returned with this estimate.</div>` : ""}

  <footer>
    Estimates for negotiation preparation, not financial advice.
    Generated by Know Your Worth. Tip: use your browser's Print → “Save as PDF” for a PDF copy.
  </footer>
</div>
</body>
</html>
`;
}

function triggerDownload(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadReport(
  report: SalaryReport,
  summary: string,
  banner?: string | null
) {
  const today = new Date().toISOString().slice(0, 10);
  triggerDownload(
    buildReportHtml(report, summary, banner),
    "text/html;charset=utf-8",
    `know-your-worth-report-${today}.html`
  );
}
