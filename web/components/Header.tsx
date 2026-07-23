"use client";

import { motion } from "framer-motion";
import { ThemeToggle } from "./ThemeToggle";

type Props = {
  /** Profile completeness, 0-100. */
  pct: number;
};

export function Header({ pct: rawPct }: Props) {
  const pct = Math.max(0, Math.min(100, Math.round(rawPct)));
  const ringCircumference = 2 * Math.PI * 9;
  const ringOffset = ringCircumference * (1 - pct / 100);

  return (
    <header className="flex items-center justify-between w-full px-4 sm:px-6 py-3.5 sm:py-4">
      <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
        <div className="h-8 w-8 sm:h-9 sm:w-9 shrink-0 rounded-xl bg-gradient-to-br from-accent-400 to-accent-700 grid place-items-center shadow-glow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v20M5 9h11a4 4 0 0 1 0 8H7" />
          </svg>
        </div>
        <div className="leading-tight min-w-0">
          <div className="text-sm font-semibold tracking-tight">Know Your Worth</div>
          <div className="hidden sm:block text-[11px] text-ink-500 dark:text-ink-400 truncate">
            Supporting information for any salary discussions.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2.5 sm:gap-4 shrink-0">
        {/* Desktop: labeled bar */}
        <div className="hidden sm:flex items-center gap-3 min-w-[200px]">
          <div className="text-[11px] uppercase tracking-wider text-ink-500 dark:text-ink-400">Profile</div>
          <div className="relative flex-1 h-1.5 rounded-full bg-ink-200/70 dark:bg-white/10 overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-accent-400 to-accent-600"
            />
          </div>
          <div className="text-[11px] tabular-nums w-8 text-right text-ink-600 dark:text-ink-300">{pct}%</div>
        </div>

        {/* Mobile: compact ring, same signal in a fraction of the width */}
        <div className="sm:hidden relative h-8 w-8" title={`Profile ${pct}% complete`}>
          <svg viewBox="0 0 24 24" className="h-8 w-8 -rotate-90">
            <circle cx="12" cy="12" r="9" fill="none" strokeWidth="3" className="stroke-ink-200/70 dark:stroke-white/10" />
            <motion.circle
              cx="12"
              cy="12"
              r="9"
              fill="none"
              strokeWidth="3"
              strokeLinecap="round"
              stroke="url(#kywRingGradient)"
              strokeDasharray={ringCircumference}
              initial={{ strokeDashoffset: ringCircumference }}
              animate={{ strokeDashoffset: ringOffset }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
            />
            <defs>
              <linearGradient id="kywRingGradient" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#42d894" />
                <stop offset="100%" stopColor="#0f9c63" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 grid place-items-center text-[8px] font-semibold tabular-nums text-ink-600 dark:text-ink-300">
            {pct}
          </div>
        </div>

        <ThemeToggle />
      </div>
    </header>
  );
}
