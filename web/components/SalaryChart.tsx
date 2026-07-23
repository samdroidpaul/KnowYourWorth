"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Cell,
  LabelList,
} from "recharts";
import type { SalaryReport } from "@/lib/types";
import { formatMoney } from "@/lib/parseResult";

type Props = { report: SalaryReport };

/**
 * Horizontal range chart: a transparent "spacer" pushes the visible bar to
 * start at Low; the gradient bar then runs Low → High. The Mid figure is
 * shown as a label at the right of each bar. Roles sorted by % of week desc.
 */
export function SalaryChart({ report }: Props) {
  const data = [...report.roles]
    .sort((a, b) => b.pct - a.pct)
    .map((r) => ({
      title: r.title,
      pct: r.pct,
      low: r.low,
      mid: r.mid,
      high: r.high,
      spacer: r.low,
      span: r.high - r.low,
      midLabel: `mid ${formatMoney(r.mid, report.currency)}`,
    }));

  const min = Math.min(...data.map((d) => d.low));
  const max = Math.max(...data.map((d) => d.high));
  const pad = (max - min) * 0.08 || max * 0.05;

  // Give every role a readable row — 8 roles in a fixed-height chart gets cramped.
  const height = Math.max(220, data.length * 48 + 40);

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 8, right: 96, left: 8, bottom: 8 }}
          barCategoryGap={18}
        >
          <CartesianGrid
            horizontal={false}
            strokeDasharray="2 4"
            stroke="currentColor"
            className="text-ink-300/40 dark:text-white/10"
          />
          <XAxis
            type="number"
            domain={[Math.max(0, min - pad), max + pad]}
            tickFormatter={(v) => formatMoney(v, report.currency).replace(/[A-Z]{3} /, "")}
            stroke="currentColor"
            className="text-ink-500 dark:text-ink-400"
            tick={{ fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="title"
            stroke="currentColor"
            className="text-ink-600 dark:text-ink-300"
            tick={{ fontSize: 12, fontWeight: 500 }}
            axisLine={false}
            tickLine={false}
            width={170}
            tickFormatter={(v: string) =>
              v.length > 40 ? v.slice(0, 39).trimEnd() + "…" : v
            }
          />
          <Tooltip
            cursor={{ fill: "rgba(15,156,99,0.06)" }}
            content={({ active, payload }) => {
              if (!active || !payload || payload.length === 0) return null;
              const d = payload[0].payload as (typeof data)[number];
              return (
                <div
                  style={{
                    borderRadius: 10,
                    border: "1px solid rgba(120,120,140,0.25)",
                    background: "rgba(20,24,36,0.96)",
                    color: "#eef0f4",
                    fontSize: 12,
                    padding: "8px 10px",
                    minWidth: 160,
                    boxShadow: "0 12px 30px -10px rgba(0,0,0,0.6)",
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>
                    {d.title} · {d.pct}%
                  </div>
                  <div style={{ opacity: 0.85, lineHeight: 1.5 }}>
                    Low&nbsp;&nbsp;{formatMoney(d.low, report.currency)}<br />
                    <strong style={{ color: "#42d894" }}>
                      Mid&nbsp;&nbsp;{formatMoney(d.mid, report.currency)}
                    </strong>
                    <br />
                    High&nbsp;&nbsp;{formatMoney(d.high, report.currency)}
                  </div>
                </div>
              );
            }}
          />
          {/* Invisible spacer pushes the bar to start at Low */}
          <Bar dataKey="spacer" stackId="r" fill="transparent" isAnimationActive={false} />
          <Bar dataKey="span" stackId="r" radius={[6, 6, 6, 6]}>
            {data.map((_, i) => (
              <Cell key={i} fill="url(#kywBarGradient)" />
            ))}
            <LabelList
              dataKey="midLabel"
              position="right"
              className="fill-ink-700 dark:fill-ink-200"
              style={{ fontSize: 11, fontWeight: 600 }}
            />
          </Bar>
          <defs>
            <linearGradient id="kywBarGradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#42d894" stopOpacity={0.55} />
              <stop offset="50%" stopColor="#1cbf78" stopOpacity={1} />
              <stop offset="100%" stopColor="#0d7c51" stopOpacity={0.85} />
            </linearGradient>
          </defs>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
