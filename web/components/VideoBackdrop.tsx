"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Clips live in public/videos/. Free-license stock footage (Mixkit license:
 * free for commercial use, no attribution required) showing a range of
 * professions — office, chef, doctor, teacher, farmer, mechanic, scientist.
 * Add or replace files and update this list to change the montage.
 */
const CLIPS = [
  "/videos/jobs-1.mp4",
  "/videos/jobs-2.mp4",
  "/videos/jobs-3.mp4",
  "/videos/jobs-4.mp4",
  "/videos/jobs-5.mp4",
  "/videos/jobs-6.mp4",
  "/videos/jobs-7.mp4",
];

/** Seconds each clip stays on screen before crossfading to the next. */
const CLIP_SECONDS = 10;
/** Crossfade duration — must match the CSS transition below. */
const FADE_MS = 1800;

/**
 * A/B crossfade montage player. Two stacked <video> elements alternate:
 * while one plays, the other preloads the next clip; on a timer the hidden
 * one fades in over the visible one, then they swap roles. Clips that fail
 * to load are dropped from rotation. Heavily faded and desaturated so the
 * chat stays readable; the aurora canvas paints over it.
 */
export function VideoBackdrop() {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const [activeSlot, setActiveSlot] = useState<0 | 1>(0);
  const [visible, setVisible] = useState(false);
  const playlist = useRef<string[]>([...CLIPS]);
  const nextIndex = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const slotRef = useCallback(
    (slot: 0 | 1) => (slot === 0 ? videoA : videoB),
    []
  );

  // Load a clip into the given slot; resolves false if the file is missing.
  const loadClip = useCallback(
    (slot: 0 | 1, src: string): Promise<boolean> =>
      new Promise((resolve) => {
        const el = slotRef(slot).current;
        if (!el) return resolve(false);
        const onReady = () => {
          cleanup();
          resolve(true);
        };
        const onError = () => {
          cleanup();
          resolve(false);
        };
        const cleanup = () => {
          el.removeEventListener("canplaythrough", onReady);
          el.removeEventListener("error", onError);
        };
        el.addEventListener("canplaythrough", onReady);
        el.addEventListener("error", onError);
        el.src = src;
        el.load();
      }),
    [slotRef]
  );

  // Pull the next playable clip into the slot, dropping any that 404.
  const loadNextInto = useCallback(
    async (slot: 0 | 1): Promise<boolean> => {
      while (playlist.current.length > 0) {
        const idx = nextIndex.current % playlist.current.length;
        const src = playlist.current[idx];
        const ok = await loadClip(slot, src);
        if (ok) {
          nextIndex.current = idx + 1;
          return true;
        }
        playlist.current.splice(idx, 1);
      }
      return false;
    },
    [loadClip]
  );

  useEffect(() => {
    // ?motion=full forces the montage on even under prefers-reduced-motion
    // (useful for demos and testing on locked-down machines).
    const forced = new URLSearchParams(window.location.search).get("motion") === "full";
    const reduced =
      !forced && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return; // aurora-only for reduced-motion users

    let cancelled = false;

    const rotate = async (current: 0 | 1) => {
      if (cancelled) return;
      const standby: 0 | 1 = current === 0 ? 1 : 0;
      const ok = await loadNextInto(standby);
      if (cancelled || !ok) return;
      timer.current = setTimeout(() => {
        if (cancelled) return;
        void slotRef(standby).current?.play().catch(() => {});
        setActiveSlot(standby);
        // Pause the outgoing clip once fully faded out.
        setTimeout(() => slotRef(current).current?.pause(), FADE_MS);
        void rotate(standby);
      }, CLIP_SECONDS * 1000);
    };

    void (async () => {
      const ok = await loadNextInto(0);
      if (cancelled || !ok) return; // no clips available — stay hidden
      void videoA.current?.play().catch(() => {});
      setVisible(true);
      void rotate(0);
    })();

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      videoA.current?.pause();
      videoB.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const common =
    "absolute inset-0 w-full h-full object-cover transition-opacity ease-in-out " +
    "[transition-duration:1800ms] saturate-[0.45] brightness-105 dark:brightness-[0.45] dark:saturate-[0.6]";

  return (
    <div
      className={`absolute inset-0 transition-opacity duration-1000 ${
        visible ? "opacity-25 dark:opacity-30" : "opacity-0"
      }`}
    >
      <video
        ref={videoA}
        muted
        loop
        playsInline
        preload="none"
        className={`${common} ${activeSlot === 0 ? "opacity-100" : "opacity-0"}`}
      />
      <video
        ref={videoB}
        muted
        loop
        playsInline
        preload="none"
        className={`${common} ${activeSlot === 1 ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}
