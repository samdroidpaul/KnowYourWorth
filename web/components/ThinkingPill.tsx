"use client";

import { motion, AnimatePresence } from "framer-motion";

type Props = {
  visible: boolean;
  label?: string;
};

export function ThinkingPill({ visible, label = "thinking…" }: Props) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.18 }}
          className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[12px] font-medium text-accent-700 dark:text-accent-300 border border-accent-200/60 dark:border-accent-700/30 shimmer"
        >
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full rounded-full bg-accent-500 opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent-500" />
          </span>
          {label}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
