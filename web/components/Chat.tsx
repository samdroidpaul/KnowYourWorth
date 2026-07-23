"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Header } from "./Header";
import { Message } from "./Message";
import { ThinkingPill } from "./ThinkingPill";
import {
  PROFILE_TOOLS,
  PROFILE_TARGET_NOTES,
  type ChatMessage,
  type SalaryReport,
} from "@/lib/types";
import { extractReport, stripJsonFence } from "@/lib/parseResult";
import { downloadCsv } from "@/lib/csv";
import { downloadReport } from "@/lib/report";
import { trackEvent } from "@/lib/analytics";
import {
  getOrCreateUserId,
  getSessionId,
  setSessionId,
  clearSessionId,
} from "@/lib/session";

const FIRST_MESSAGE =
  "Hi, I'd like to understand my market worth — can we start?";

/**
 * Demo accelerator: typing `/demo`, `/demo1`, `/demo2`, or `/demo3` expands
 * into a full persona paragraph before sending — nothing renders in the UI,
 * so judges see a normal composer but don't have to type or paste a
 * paragraph on a 3-minute clock. `/demo` picks one at random.
 */
const DEMO_PERSONAS = [
  "I'm a senior software engineer in New Zealand with 8 years of experience, mostly Python and AWS, mentoring two juniors and leading the platform team's roadmap.",
  "I'm a data scientist based in Sydney with 5 years experience, working with Python, SQL and dbt, and I split my week between modelling work and stakeholder workshops.",
  "I'm a senior product designer working remotely for a US SaaS, 7 years of experience, leading design for the billing and onboarding squads and managing two designers.",
];

function resolveDemoText(raw: string): string {
  const m = raw.trim().match(/^\/demo(\d)?$/i);
  if (!m) return raw;
  const idx = m[1] ? Math.min(DEMO_PERSONAS.length, Math.max(1, parseInt(m[1], 10))) - 1 : Math.floor(Math.random() * DEMO_PERSONAS.length);
  return DEMO_PERSONAS[idx];
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * The ADK SSE stream is a sequence of `data: <json>\n\n` frames. Each frame
 * is an ADK event with `content.parts[]`. Parts can be text (model tokens)
 * or function_call / function_response (tool events).
 *
 * We do NOT show tool-call internals to the user — just a "thinking…" pill.
 * Profile completeness is estimated from `note_person` / `finalize_person`
 * call counts (see PROFILE_TOOLS).
 */
type AdkFn = { name?: string; id?: string; args?: unknown };

type AdkPart = {
  text?: string;
  functionCall?: AdkFn;
  function_call?: AdkFn;
  functionResponse?: AdkFn;
  function_response?: AdkFn;
};

type AdkEvent = {
  content?: { parts?: AdkPart[]; role?: string };
  partial?: boolean;
  author?: string;
};

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const [latestReport, setLatestReport] = useState<SalaryReport | null>(null);
  const [latestSummary, setLatestSummary] = useState("");
  const [latestBanner, setLatestBanner] = useState<string | null>(null);
  const [bannerPending, setBannerPending] = useState(false);
  const [preparingDownload, setPreparingDownload] = useState(false);
  const [ready, setReady] = useState(false);
  const [started, setStarted] = useState(false);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const downloadMenuRef = useRef<HTMLDivElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const recoveryRef = useRef<{ cancelled: boolean } | null>(null);
  // Lets sendMessage replay itself once after a stale-session recovery.
  const sendMessageRef = useRef<
    ((text: string, opts?: { staleRetry?: boolean }) => Promise<void>) | null
  >(null);
  // Message id a banner has already been requested for (one shot per report).
  const bannerRequestedFor = useRef<string | null>(null);
  // syncMessage re-runs on every streamed chunk after the JSON block
  // completes (while summary prose keeps arriving) — this guards the
  // report_generated analytics event to one fire per message.
  const reportTrackedFor = useRef<string | null>(null);
  // Mirrors latestBanner synchronously so the download handlers can read the
  // freshest value right after awaiting the in-flight request, without
  // waiting an extra render for React state to settle.
  const latestBannerRef = useRef<string | null>(null);
  // The in-flight banner fetch, if any — download handlers can await this
  // (with a timeout) instead of firing before a fast-enough image lands.
  const bannerPromiseRef = useRef<Promise<void> | null>(null);

  /**
   * Ask the server to generate an AI banner illustration for the report and
   * attach it to the message. Failures (no API key, quota, model error)
   * simply leave the report bannerless — this never surfaces an error.
   * Download handlers may await the returned promise for a short window so
   * a fast banner still makes it into an immediate download.
   */
  const requestBanner = useCallback(
    (messageId: string, report: SalaryReport) => {
      if (bannerRequestedFor.current === messageId) return bannerPromiseRef.current;
      bannerRequestedFor.current = messageId;
      setBannerPending(true);
      const promise = (async () => {
        try {
          const res = await fetch("/api/banner", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              roles: report.roles.map((r) => ({ title: r.title, pct: r.pct })).slice(0, 6),
              location: report.location,
            }),
          });
          if (!res.ok) return;
          const { image } = (await res.json()) as { image?: string | null };
          if (!image) return;
          latestBannerRef.current = image;
          setLatestBanner(image);
          setMessages((prev) =>
            prev.map((m) => (m.id === messageId ? { ...m, banner: image } : m))
          );
          trackEvent("banner_generated");
        } catch {
          // banner is decorative — never surface a failure
        } finally {
          setBannerPending(false);
        }
      })();
      bannerPromiseRef.current = promise;
      return promise;
    },
    []
  );

  /**
   * If a banner request is still in flight, give it a brief window to land
   * before proceeding — avoids the race where "Download Report" fires the
   * instant the table appears, before an otherwise-successful image call
   * has had time to return.
   */
  const waitForBanner = useCallback(async (timeoutMs: number) => {
    if (!bannerPromiseRef.current) return;
    await Promise.race([
      bannerPromiseRef.current,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }, []);

  const handleDownloadReport = useCallback(async () => {
    if (!latestReport) return;
    if (bannerPromiseRef.current && !latestBannerRef.current) {
      // Image generation typically takes ~10-15s — worth a bounded wait so
      // a click right as the table appears doesn't reliably lose the race.
      setPreparingDownload(true);
      await waitForBanner(16000);
      setPreparingDownload(false);
    }
    downloadReport(latestReport, latestSummary, latestBannerRef.current);
    trackEvent("download_report", { with_banner: !!latestBannerRef.current });
  }, [latestReport, latestSummary, waitForBanner]);

  const handleDownloadCsv = useCallback(() => {
    if (!latestReport) return;
    downloadCsv(latestReport);
    trackEvent("download_csv");
  }, [latestReport]);

  // Ensure a session before the first message.
  const ensureSession = useCallback(async (): Promise<string> => {
    const userId = getOrCreateUserId();
    let sid = getSessionId();
    if (sid) return sid;
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Could not start a session. ${t}`);
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    setSessionId(sessionId);
    return sessionId;
  }, []);

  useEffect(() => {
    setReady(true);
  }, []);

  // Close the mobile download menu on an outside click.
  useEffect(() => {
    if (!downloadMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!downloadMenuRef.current?.contains(e.target as Node)) {
        setDownloadMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [downloadMenuOpen]);

  /**
   * The agent's turn text as persisted in the ADK session: everything the
   * agent emitted after the most recent user message. Used to recover a
   * finished report when the live SSE stream dropped mid-run.
   */
  const fetchPendingTurnText = useCallback(async (): Promise<string | null> => {
    const userId = getOrCreateUserId();
    const sid = getSessionId();
    if (!sid) return null;
    const res = await fetch(
      `/api/session?userId=${encodeURIComponent(userId)}&sessionId=${encodeURIComponent(sid)}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      events?: Array<{
        author?: string;
        content?: { role?: string; parts?: AdkPart[] };
      }>;
    };
    const events = data.events ?? [];
    let lastUserIdx = -1;
    events.forEach((e, i) => {
      if (e.content?.role === "user" || e.author === "user") lastUserIdx = i;
    });
    const texts: string[] = [];
    for (let i = lastUserIdx + 1; i < events.length; i++) {
      for (const p of events[i].content?.parts ?? []) {
        if (typeof p.text === "string" && p.text) texts.push(p.text);
      }
    }
    return texts.length ? texts.join("\n\n") : null;
  }, []);

  /**
   * Poll the persisted session for up to ~2 minutes after a stream that
   * ended without a report. If the run finished server-side, pull its full
   * turn text (and report) into the message the stream left behind.
   */
  const startRecovery = useCallback(
    (assistantMsgId: string, showPill: boolean) => {
      if (recoveryRef.current) recoveryRef.current.cancelled = true;
      const token = { cancelled: false };
      recoveryRef.current = token;
      if (showPill) setToolBusy(true);

      void (async () => {
        for (const delay of [4000, 8000, 15000, 30000, 60000]) {
          await new Promise((r) => setTimeout(r, delay));
          if (token.cancelled) return;
          try {
            const text = await fetchPendingTurnText();
            if (token.cancelled) return;
            if (text) {
              const report = extractReport(text);
              if (report) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId ? { ...m, text, report } : m
                  )
                );
                setLatestReport(report);
                setLatestSummary(stripJsonFence(text));
                setNoteCount(PROFILE_TARGET_NOTES);
                requestBanner(assistantMsgId, report);
                if (reportTrackedFor.current !== assistantMsgId) {
                  reportTrackedFor.current = assistantMsgId;
                  trackEvent("report_generated", {
                    role_count: report.roles.length,
                    currency: report.currency,
                    location: report.location,
                    via: "recovery",
                  });
                }
                setToolBusy(false);
                return;
              }
            }
          } catch {
            // transient poll failure — try again on the next tick
          }
        }
        if (!token.cancelled && showPill) setToolBusy(false);
      })();
    },
    [fetchPendingTurnText, requestBanner]
  );

  // Auto-scroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, toolBusy]);

  const sendMessage = useCallback(
    async (text: string, opts?: { staleRetry?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;

      // A new turn supersedes any pending report recovery.
      if (recoveryRef.current) {
        recoveryRef.current.cancelled = true;
        recoveryRef.current = null;
      }

      if (!started) trackEvent("start_conversation");
      setError(null);
      setStarted(true);
      const userMsg: ChatMessage = {
        id: newId(),
        role: "user",
        text: trimmed,
      };
      const assistantMsg: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: "",
        streaming: true,
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setSending(true);

      let sessionId: string;
      try {
        sessionId = await ensureSession();
      } catch (e) {
        setSending(false);
        setError(e instanceof Error ? e.message : "Could not start session.");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, streaming: false } : m
          )
        );
        return;
      }

      const userId = getOrCreateUserId();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      // Observed at stream close, to decide whether to hunt for a report
      // that finished server-side after the connection dropped.
      let finalTextAtClose = "";
      let toolOpenAtClose = false;
      let userAborted = false;
      // Set when the backend rejects our stored session id (it keeps
      // sessions in memory, so restarts/redeploys forget them).
      let staleSession = false;

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ userId, sessionId, message: trimmed }),
          signal: ctrl.signal,
        });
        if (!res.body) throw new Error("Empty response body.");

        const reader = res.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";
        // ADK streaming sends incremental chunks flagged `partial: true`,
        // then re-sends the turn's COMPLETE text in one final event with
        // partial unset. Appending both duplicates every message, so we keep
        // finished turns in `committed` and let the final event supersede
        // whatever partials accumulated in `pending`.
        let committed = "";
        let pending = "";
        // The final aggregate event also repeats the turn's function calls,
        // so the profile meter must dedupe before counting.
        const seenCalls = new Set<string>();

        const displayText = () =>
          committed && pending ? `${committed}\n\n${pending}` : committed + pending;

        const syncMessage = () => {
          const full = displayText();
          finalTextAtClose = full;
          const report = extractReport(full);
          if (report) {
            setLatestReport(report);
            setLatestSummary(stripJsonFence(full));
            setNoteCount(PROFILE_TARGET_NOTES);
            requestBanner(assistantMsg.id, report);
            if (reportTrackedFor.current !== assistantMsg.id) {
              reportTrackedFor.current = assistantMsg.id;
              trackEvent("report_generated", {
                role_count: report.roles.length,
                currency: report.currency,
                location: report.location,
                via: "stream",
              });
            }
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, text: full, report: report || m.report }
                : m
            )
          );
        };

        const applyChunk = () => {
          // Process complete SSE frames (separated by blank line).
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const lines = frame.split("\n");
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (dataLines.length === 0) continue;
            const data = dataLines.join("\n");

            if (eventName === "client_error") {
              let msg = "Stream error.";
              try {
                const err = JSON.parse(data) as { message?: string };
                if (err.message) msg = err.message;
              } catch {
                // keep generic message
              }
              if (/session not found/i.test(msg)) {
                // Stale session — handled after the stream ends (fresh
                // session + automatic replay), so don't surface the error.
                staleSession = true;
              } else {
                setError(msg);
              }
              continue;
            }

            let evt: AdkEvent;
            try {
              evt = JSON.parse(data) as AdkEvent;
            } catch {
              continue;
            }

            const parts = evt.content?.parts ?? [];
            let eventText = "";
            for (const p of parts) {
              if (typeof p.text === "string" && p.text.length > 0) {
                eventText += p.text;
              }
              const fnCall = p.functionCall || p.function_call;
              const fnResp = p.functionResponse || p.function_response;
              if (fnCall) {
                setToolBusy(true);
                toolOpenAtClose = true;
                const key =
                  fnCall.id ||
                  `${fnCall.name}:${JSON.stringify(fnCall.args ?? null)}`;
                if (!seenCalls.has(key)) {
                  seenCalls.add(key);
                  if (fnCall.name === "finalize_person") {
                    // Profile is complete once the agent finalizes it.
                    setNoteCount(PROFILE_TARGET_NOTES);
                  } else if (fnCall.name && PROFILE_TOOLS.has(fnCall.name)) {
                    setNoteCount((n) => Math.min(n + 1, PROFILE_TARGET_NOTES));
                  }
                }
              }
              if (fnResp) {
                setToolBusy(false);
                toolOpenAtClose = false;
              }
            }

            if (eventText) {
              if (evt.partial) {
                pending += eventText;
              } else {
                // Final event for this turn — carries the complete text.
                committed = committed ? `${committed}\n\n${eventText}` : eventText;
                pending = "";
              }
              syncMessage();
              // Once real text arrives, the agent isn't "thinking" anymore.
              setToolBusy(false);
              toolOpenAtClose = false;
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          applyChunk();
        }
        // Flush any tail.
        buffer += decoder.decode();
        applyChunk();
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          userAborted = true;
        } else {
          setError(e instanceof Error ? e.message : "Stream failed.");
        }
      } finally {
        abortRef.current = null;
        setSending(false);
        setToolBusy(false);
        if (staleSession && !opts?.staleRetry && !userAborted) {
          // The service forgot our session (in-memory sessions don't survive
          // a restart or redeploy). Drop the failed exchange, mint a fresh
          // session, and replay this message once.
          clearSessionId();
          setMessages((prev) =>
            prev.filter((m) => m.id !== userMsg.id && m.id !== assistantMsg.id)
          );
          void sendMessageRef.current?.(trimmed, { staleRetry: true });
        } else {
          if (staleSession) {
            setError(
              "The agent service couldn't find the conversation even with a fresh session. If this persists, the backend is likely running in-memory sessions across multiple Cloud Run instances — redeploy with max 1 instance or a persistent session service."
            );
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, streaming: false } : m
            )
          );
          // Final report scan in case the JSON closed on the last chunk.
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantMsg.id) return m;
              const finalReport = extractReport(m.text);
              return finalReport ? { ...m, report: finalReport } : m;
            })
          );
          // The connection can drop while the agent is still working (long
          // BigQuery lookups run silently). ADK persists the finished turn to
          // the session, so poll for it and pull the report in when it lands.
          if (!userAborted && !staleSession && !extractReport(finalTextAtClose)) {
            startRecovery(assistantMsg.id, toolOpenAtClose);
          }
        }
      }
    },
    [ensureSession, sending, startRecovery, requestBanner]
  );

  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const text = resolveDemoText(input);
    setInput("");
    void sendMessage(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (input.trim()) {
        const text = resolveDemoText(input);
        setInput("");
        void sendMessage(text);
      }
    }
  };

  const startConversation = () => {
    void sendMessage(FIRST_MESSAGE);
  };

  const resetConversation = () => {
    abortRef.current?.abort();
    if (recoveryRef.current) {
      recoveryRef.current.cancelled = true;
      recoveryRef.current = null;
    }
    clearSessionId();
    setMessages([]);
    setNoteCount(0);
    setLatestReport(null);
    setLatestSummary("");
    setLatestBanner(null);
    latestBannerRef.current = null;
    bannerRequestedFor.current = null;
    reportTrackedFor.current = null;
    bannerPromiseRef.current = null;
    setBannerPending(false);
    setPreparingDownload(false);
    setError(null);
    setStarted(false);
    setToolBusy(false);
  };

  const empty = useMemo(() => messages.length === 0, [messages.length]);

  // Profile completeness. The deployed agent doesn't always surface its
  // note_person calls in the SSE stream, so answered user turns are the
  // primary signal, tool-call counts the secondary; the report (or a
  // finalize_person call) pins it to 100%. Capped at 90% until then so the
  // meter never claims "done" before the agent is.
  const userTurns = messages.filter((m) => m.role === "user").length;
  const profilePct = latestReport
    ? 100
    : Math.min(
        90,
        Math.round(
          (Math.max(noteCount, userTurns) / PROFILE_TARGET_NOTES) * 100
        )
      );

  if (!ready) return null;

  return (
    <div
      className="glass shadow-card rounded-3xl overflow-hidden flex flex-col relative
        w-[calc(100vw-2rem)] h-[calc(100dvh-2rem)]
        md:w-[70vw] md:h-[80vh] md:max-w-[1280px]"
    >
      <Header pct={profilePct} />

      <div
        ref={scrollRef}
        className="chat-scroll flex-1 overflow-y-auto px-6 pb-6 pt-2"
      >
        <AnimatePresence>
          {empty ? (
            <EmptyState key="empty" onStart={startConversation} />
          ) : (
            <div key="thread" className="flex flex-col gap-4">
              {messages.map((m) => (
                <Message key={m.id} message={m} bannerLoading={bannerPending} />
              ))}
              <div className="pl-1 h-6">
                <ThinkingPill visible={toolBusy} />
              </div>
            </div>
          )}
        </AnimatePresence>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 text-[12px] text-red-600 dark:text-red-300 bg-red-50/80 dark:bg-red-900/20 border border-red-200/70 dark:border-red-700/40 px-3 py-2 rounded-lg flex items-center justify-between gap-3"
          >
            <span className="line-clamp-2">{error}</span>
            <button
              onClick={() => {
                setError(null);
                if (messages.length > 0) {
                  const last = [...messages].reverse().find((m) => m.role === "user");
                  if (last) void sendMessage(last.text);
                }
              }}
              className="text-[11px] font-medium px-2 py-1 rounded-md border border-red-300/60 dark:border-red-600/50 hover:bg-red-100/60 dark:hover:bg-red-900/30"
            >
              Retry
            </button>
          </motion.div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-ink-200/60 dark:border-white/5 px-4 py-3 bg-white/40 dark:bg-ink-950/40 backdrop-blur-md">
        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                started
                  ? "Tell me more about your role…"
                  : "Type a message, or tap Start to begin."
              }
              rows={1}
              className="w-full resize-none rounded-xl bg-white dark:bg-white/5 border border-ink-200 dark:border-white/10 px-3.5 py-2.5 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-accent-500/40 placeholder:text-ink-400 dark:placeholder:text-ink-500 max-h-40"
              style={{ minHeight: 42 }}
            />
          </div>

          {started && (
            <button
              type="button"
              onClick={resetConversation}
              title="Start over"
              aria-label="Start over"
              className="h-[42px] w-[42px] sm:w-auto sm:px-3 rounded-xl text-[12px] font-medium border border-ink-200 dark:border-white/10 bg-white dark:bg-white/5 hover:bg-ink-50 dark:hover:bg-white/10 text-ink-600 dark:text-ink-300 inline-flex items-center justify-center gap-1.5 shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 3-6.7" />
                <path d="M3 4v5h5" />
              </svg>
              <span className="hidden sm:inline">Reset</span>
            </button>
          )}

          {latestReport && (
            <>
              {/* Desktop: two explicit buttons */}
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.9, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 20 }}
                onClick={() => void handleDownloadReport()}
                disabled={preparingDownload}
                title={
                  bannerPending && !latestBanner
                    ? "Generating your banner illustration (~10-15s) — the download will wait briefly to include it"
                    : "Download the full salary report (chart, table, and summary — print to PDF from your browser)"
                }
                className="hidden sm:inline-flex h-[42px] px-3.5 rounded-xl text-sm font-semibold bg-accent-600 hover:bg-accent-700 text-white shadow-glow items-center gap-2 transition shrink-0 disabled:opacity-70 disabled:cursor-wait"
              >
                {preparingDownload ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="animate-spin">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                    </svg>
                    Preparing&nbsp;image…
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <path d="M14 2v6h6" />
                      <path d="M12 18v-6" />
                      <path d="m9 15 3 3 3-3" />
                    </svg>
                    Download&nbsp;Report
                  </>
                )}
              </motion.button>
              <motion.button
                type="button"
                initial={{ opacity: 0, scale: 0.9, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.05 }}
                onClick={handleDownloadCsv}
                title="Download the raw numbers as CSV"
                className="hidden sm:inline-flex h-[42px] px-3 rounded-xl text-sm font-semibold border border-accent-500/50 text-accent-700 dark:text-accent-300 bg-accent-500/10 hover:bg-accent-500/20 items-center gap-2 transition shrink-0"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 3v12" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M5 21h14" />
                </svg>
                CSV
              </motion.button>

              {/* Mobile: single collapsed menu so the row doesn't crowd */}
              <div className="sm:hidden relative shrink-0" ref={downloadMenuRef}>
                <motion.button
                  type="button"
                  initial={{ opacity: 0, scale: 0.9, y: 4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  transition={{ type: "spring", stiffness: 260, damping: 20 }}
                  onClick={() => setDownloadMenuOpen((v) => !v)}
                  title="Download options"
                  aria-label="Download options"
                  aria-expanded={downloadMenuOpen}
                  className="h-[42px] w-[42px] rounded-xl bg-accent-600 hover:bg-accent-700 text-white shadow-glow inline-flex items-center justify-center transition"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3v12" />
                    <path d="m7 10 5 5 5-5" />
                    <path d="M5 21h14" />
                  </svg>
                </motion.button>
                <AnimatePresence>
                  {downloadMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 6, scale: 0.96 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 6, scale: 0.96 }}
                      transition={{ duration: 0.15 }}
                      className="absolute bottom-[50px] right-0 w-52 rounded-xl border border-ink-200/70 dark:border-white/10 bg-white dark:bg-ink-900 shadow-card overflow-hidden z-10"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setDownloadMenuOpen(false);
                          void handleDownloadReport();
                        }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-3 text-sm text-left hover:bg-ink-50 dark:hover:bg-white/5"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-600 dark:text-accent-400">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <path d="M14 2v6h6" />
                        </svg>
                        Full report (HTML)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          handleDownloadCsv();
                          setDownloadMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-3 text-sm text-left border-t border-ink-100 dark:border-white/5 hover:bg-ink-50 dark:hover:bg-white/5"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-600 dark:text-accent-400">
                          <path d="M12 3v12" />
                          <path d="m7 10 5 5 5-5" />
                          <path d="M5 21h14" />
                        </svg>
                        Raw numbers (CSV)
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          )}

          {!started ? (
            <button
              type="button"
              onClick={startConversation}
              disabled={sending}
              className="h-[42px] px-4 rounded-xl text-sm font-semibold bg-accent-600 hover:bg-accent-700 text-white shadow-glow disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              Start
            </button>
          ) : (
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="h-[42px] px-4 rounded-xl text-sm font-semibold bg-accent-600 hover:bg-accent-700 text-white shadow-glow disabled:opacity-40 disabled:cursor-not-allowed transition inline-flex items-center gap-2"
            >
              Send
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </button>
          )}
        </form>
        <div className="mt-2 text-center text-[10.5px] text-ink-500 dark:text-ink-400 tracking-wide">
          Estimates for negotiation preparation, not financial advice.
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.4 }}
      className="h-full flex flex-col items-center justify-center text-center px-6 py-10 gap-6"
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 140, damping: 14, delay: 0.1 }}
        className="h-14 w-14 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-700 grid place-items-center shadow-glow"
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2v20M5 9h11a4 4 0 0 1 0 8H7" />
        </svg>
      </motion.div>

      <div className="max-w-xl space-y-3">
        <motion.h1
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-2xl md:text-3xl font-semibold tracking-tight"
        >
          Walk in knowing what you're worth.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="text-ink-600 dark:text-ink-300 text-[15px] leading-relaxed"
        >
          Helping you have an honest conversation based on current market
          information in Australia / New Zealand, to help you with salary
          conversations.
        </motion.p>
      </div>

      <motion.button
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.22 }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        onClick={onStart}
        className="px-5 py-2.5 rounded-xl bg-accent-600 hover:bg-accent-700 text-white text-sm font-semibold shadow-glow inline-flex items-center gap-2"
      >
        Let&apos;s have a discussion about you
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12h14" />
          <path d="m12 5 7 7-7 7" />
        </svg>
      </motion.button>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full mt-2"
      >
        {[
          {
            icon: (
              <path d="M8 12h8M8 8h8M8 16h5" />
            ),
            title: "Tell us about your week",
            body: "A short, natural conversation about what you actually do.",
          },
          {
            icon: (
              <>
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
                <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
              </>
            ),
            title: "We check real market data",
            body: "Grounded in a live salary dataset, not a guess.",
          },
          {
            icon: (
              <>
                <path d="M12 2v12" />
                <path d="m7 9 5 5 5-5" />
                <path d="M5 21h14" />
              </>
            ),
            title: "Walk away with a range",
            body: "A defensible number, plus a report you can keep.",
          },
        ].map((step, i) => (
          <div
            key={step.title}
            className="rounded-xl border border-ink-200/60 dark:border-white/10 bg-white/50 dark:bg-white/[0.03] px-4 py-3.5 text-left"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <div className="h-6 w-6 shrink-0 rounded-md bg-accent-500/15 grid place-items-center text-accent-700 dark:text-accent-300">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {step.icon}
                </svg>
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-500 dark:text-ink-400">
                Step {i + 1}
              </div>
            </div>
            <div className="text-[13px] font-semibold text-ink-800 dark:text-ink-100">{step.title}</div>
            <div className="text-[12px] text-ink-500 dark:text-ink-400 mt-0.5 leading-snug">{step.body}</div>
          </div>
        ))}
      </motion.div>
    </motion.div>
  );
}
