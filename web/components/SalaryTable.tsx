"use client";

import { motion } from "framer-motion";
import type { SalaryReport } from "@/lib/types";
import { formatMoney, weightedAverages } from "@/lib/parseResult";
import { SalaryChart } from "./SalaryChart";
import { BannerLoading } from "./BannerLoading";

type Props = { report: SalaryReport; banner?: string; bannerLoading?: boolean };

export function SalaryTable({ report, banner, bannerLoading }: Props) {
  const sorted = [...report.roles].sort((a, b) => b.pct - a.pct);
  const cur = report.currency || "";
  const avg = weightedAverages(report);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      className="mt-4 rounded-2xl border border-ink-200/60 dark:border-white/10 bg-white/85 dark:bg-ink-900/70 backdrop-blur-md shadow-card overflow-hidden"
    >
      {banner ? (
        <motion.img
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8 }}
          src={banner}
          alt="Illustration of your main role"
          className="w-full h-28 md:h-36 object-cover"
        />
      ) : (
        bannerLoading && <BannerLoading />
      )}
      <div className="px-5 pt-5 pb-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-ink-500 dark:text-ink-400 font-medium">
          Your range
        </div>
        <div className="mt-1 text-lg font-semibold tracking-tight">
          {report.location ? `Market view — ${report.location}` : "Market view"}
        </div>
        {!report.currency && (
          <div className="mt-1 text-[11px] text-ink-500 dark:text-ink-400">
            Note: the figure currency wasn't returned with this estimate.
          </div>
        )}
      </div>

      <div className="px-5 pb-3">
        <SalaryChart report={report} />
      </div>

      <div className="overflow-x-auto px-2 pb-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400">
              <th className="text-left font-medium px-3 py-2">Role</th>
              <th className="text-right font-medium px-3 py-2">% of week</th>
              <th className="text-right font-medium px-3 py-2">Low</th>
              <th className="text-right font-medium px-3 py-2">Mid</th>
              <th className="text-right font-medium px-3 py-2">High</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <motion.tr
                key={`${r.title}-${i}`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.08 + i * 0.05 }}
                className="border-t border-ink-200/60 dark:border-white/10"
              >
                <td className="px-3 py-3 font-medium">{r.title}</td>
                <td className="px-3 py-3 text-right tabular-nums text-ink-600 dark:text-ink-300">{r.pct}%</td>
                <td className="px-3 py-3 text-right tabular-nums">{formatMoney(r.low, cur)}</td>
                <td className="px-3 py-3 text-right tabular-nums font-semibold">{formatMoney(r.mid, cur)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{formatMoney(r.high, cur)}</td>
              </motion.tr>
            ))}
          </tbody>
          {avg && (
            <tfoot>
              <motion.tr
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.12 + sorted.length * 0.05 }}
                className="border-t-2 border-accent-500/60 bg-accent-500/5"
              >
                <td className="px-3 py-3 font-semibold">
                  Weighted average{" "}
                  <span className="text-[11px] font-normal text-ink-500 dark:text-ink-400">
                    {avg.totalPct === 100 ? "(by % of week)" : "(shares normalized)"}
                  </span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-semibold text-ink-600 dark:text-ink-300">
                  100%
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-semibold">
                  {formatMoney(avg.low, cur)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-bold text-accent-700 dark:text-accent-300">
                  {formatMoney(avg.mid, cur)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums font-semibold">
                  {formatMoney(avg.high, cur)}
                </td>
              </motion.tr>
            </tfoot>
          )}
        </table>
      </div>
    </motion.div>
  );
}
