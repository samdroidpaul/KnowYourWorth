"use client";

import { useEffect, useRef } from "react";
import { VideoBackdrop } from "./VideoBackdrop";

type AuroraBlob = {
  bx: number; // base position, fraction of viewport
  by: number;
  r: number; // radius, fraction of max(viewport)
  light: [number, number, number];
  dark: [number, number, number];
  lightAlpha: number;
  darkAlpha: number;
  speed: number;
  phase: number;
  ax: number; // wander amplitude, fraction of viewport
  ay: number;
};

// Alphas kept low so the professions footage beneath stays legible.
const BLOBS: AuroraBlob[] = [
  { bx: 0.18, by: 0.22, r: 0.55, light: [28, 191, 120], dark: [28, 191, 120], lightAlpha: 0.30, darkAlpha: 0.22, speed: 0.36, phase: 0.0, ax: 0.14, ay: 0.11 },
  { bx: 0.84, by: 0.30, r: 0.50, light: [59, 130, 246], dark: [59, 130, 246], lightAlpha: 0.22, darkAlpha: 0.17, speed: 0.28, phase: 2.1, ax: 0.12, ay: 0.13 },
  { bx: 0.50, by: 0.88, r: 0.58, light: [244, 114, 182], dark: [217, 70, 239], lightAlpha: 0.16, darkAlpha: 0.12, speed: 0.22, phase: 4.2, ax: 0.16, ay: 0.10 },
  { bx: 0.36, by: 0.55, r: 0.42, light: [45, 212, 191], dark: [45, 212, 191], lightAlpha: 0.19, darkAlpha: 0.13, speed: 0.31, phase: 1.3, ax: 0.10, ay: 0.14 },
];

/**
 * Animated aurora backdrop rendered on canvas — soft radial-gradient blobs
 * wandering on layered sine paths, so the motion is unmistakable (unlike a
 * static CSS wash). Renders at half resolution for cheap frames, honors
 * prefers-reduced-motion, and adapts colors to light/dark per frame.
 *
 * Beneath the aurora, <VideoBackdrop /> crossfades through faded stock
 * clips of different professions from public/videos/.
 */
export function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const resize = () => {
      // Half-resolution render, CSS upscales — the blobs are blurry by nature.
      canvas.width = Math.max(1, Math.floor(window.innerWidth * 0.5));
      canvas.height = Math.max(1, Math.floor(window.innerHeight * 0.5));
    };
    resize();
    window.addEventListener("resize", resize);

    const draw = (tMs: number) => {
      const w = canvas.width;
      const h = canvas.height;
      const isDark = document.documentElement.classList.contains("dark");
      const t = tMs * 0.001;
      ctx.clearRect(0, 0, w, h);
      for (const b of BLOBS) {
        const x =
          (b.bx +
            Math.sin(t * b.speed + b.phase) * b.ax +
            Math.cos(t * b.speed * 0.7 + b.phase * 1.7) * b.ax * 0.5) * w;
        const y =
          (b.by +
            Math.cos(t * b.speed * 0.9 + b.phase) * b.ay +
            Math.sin(t * b.speed * 0.6 + b.phase * 0.9) * b.ay * 0.5) * h;
        const r =
          b.r * Math.max(w, h) * (1 + 0.08 * Math.sin(t * b.speed * 1.3 + b.phase));
        const [cr, cg, cb] = isDark ? b.dark : b.light;
        const a = isDark ? b.darkAlpha : b.lightAlpha;
        const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    };

    if (reduced) {
      draw(0);
    } else {
      const loop = (t: number) => {
        if (!running) return;
        draw(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Base wash */}
      <div className="absolute inset-0 backdrop-base" />

      {/* Crossfading professions montage */}
      <VideoBackdrop />

      {/* Aurora */}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      {/* Grid overlay */}
      <div className="absolute inset-0 grid-overlay" />

      {/* Vignette */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_55%,rgba(7,10,20,0.18)_100%)] dark:bg-[radial-gradient(ellipse_at_center,transparent_50%,rgba(0,0,0,0.55)_100%)]" />
    </div>
  );
}
