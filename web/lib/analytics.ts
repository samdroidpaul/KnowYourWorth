"use client";

/**
 * Thin wrapper around gtag.js. The script itself is loaded conditionally in
 * app/layout.tsx (only when NEXT_PUBLIC_GA_MEASUREMENT_ID is set), so every
 * call here is a no-op — never a throw — when analytics isn't configured or
 * hasn't finished loading yet. Analytics must never be able to break the app.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || "";

export function trackEvent(name: string, params?: Record<string, unknown>) {
  if (typeof window === "undefined" || !window.gtag) return;
  try {
    window.gtag("event", name, params);
  } catch {
    // analytics is best-effort — never let a tracking call break the UI
  }
}
