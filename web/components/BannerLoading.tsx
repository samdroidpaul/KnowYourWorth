"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Image generation genuinely takes ~10-15s — long enough that a static
 * "loading…" label starts to feel broken. Cycling a few dry-humor lines
 * turns the wait into part of the personality instead of a stall.
 */
const LINES = [
  "Illustrating your role…",
  "Aligning the Hubble telescope for a better angle…",
  "Consulting a very opinionated art director…",
  "Negotiating with the pixels…",
  "Waiting for the paint to dry, digitally…",
  "Asking the AI to stop overthinking the lighting…",
];

export function BannerLoading() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % LINES.length), 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="relative w-full h-28 md:h-36 shimmer flex items-center justify-center overflow-hidden">
      <span className="relative flex h-1.5 w-1.5 mr-2 shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-accent-500 opacity-75 animate-ping" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent-500" />
      </span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.25 }}
          className="text-[11px] text-ink-500 dark:text-ink-400"
        >
          {LINES[i]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}
