# Architecture

Two agents, one job each. A knowledge agent that owns facts, a conversation
agent that owns the interview. The rest of the system is glue that makes
this split safe and observable.

## The picture

```
                            ┌──────────────────┐
                            │      Browser     │
                            └────────┬─────────┘
                                     │  HTTPS, own origin only
                                     ▼
                            ┌──────────────────┐
                            │   Next.js UI     │  Cloud Run, public
                            │  (proxy + SPA)   │  runs as salary-web-sa
                            └────────┬─────────┘
                                     │  server-side, signed ID token
                                     │  aud = orchestrator base URL
                                     ▼
                            ┌──────────────────┐
                            │   Orchestrator   │  Cloud Run, locked
                            │   (ADK agent)    │  invoker = web SA only
                            └────────┬─────────┘
                                     │
                    ┌────────────────┼────────────────┬────────────────┐
                    ▼                ▼                ▼                ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  BigQuery    │  │   Gemini     │  │  Firestore   │  │ Model Armor  │
            │  data agent  │  │ (Vertex AI)  │  │  (default)   │  │  (optional)  │
            │  the FACTS   │  │  reasoning   │  │  memory      │  │  safety      │
            └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

Model Armor isn't a separate call in the flow — it wraps every Gemini call as
`before_model_callback` / `after_model_callback` on the orchestrator's own
agent, screening the prompt on the way in and the response on the way out.
No template configured, no screening — it's entirely optional and fails open
if it errors. See [`model-armor-monitoring.md`](model-armor-monitoring.md)
for setup, the region gotcha we hit standing it up, and how a block bubbles
up into an alert.

## The five layers

### 1. Browser (public)

Talks to the Next.js origin only. No secrets, no direct calls to the
orchestrator, no service-account keys. This is a hard rule — anything the
browser holds is stealable, so it holds nothing sensitive.

### 2. Next.js UI (Cloud Run, public)

Three responsibilities:
- **Serve the SPA.** Chat, streaming, salary table, CSV download, and the
  AI-generated banner illustration for a finished report.
- **Proxy every backend call.** Both `/api/session` and `/api/chat` run
  server-side, mint an ID token, and forward with the token attached.
- **Generate the report banner.** `/api/banner` calls Gemini's image model
  directly (`gemini-2.5-flash-image`) with the report's dominant role and
  location — this is the *web app* calling Gemini, not the orchestrator, so
  it's outside the grounding-critical path entirely. It's decorative: no key
  configured, or the call fails for any reason, and the report renders
  identically minus the image. Never blocks the chat.

Runs as `salary-web-sa`. This SA is the only principal that can invoke the
orchestrator.

### 3. Orchestrator (Cloud Run, locked down)

An ADK agent, packaged as a container by `adk deploy`. Uses **Gemini** for
reasoning and six tools to do everything else. The critical design point
is in the system instruction: **no role or salary figure may appear in a
response unless it came back from a tool call to the BigQuery data agent.**

`--no-allow-unauthenticated`. `roles/run.invoker` is granted to
`salary-web-sa` and nothing else. A direct curl to the orchestrator URL
returns 403.

### 4. BigQuery data agent (Conversational Analytics)

The knowledge layer. Published Conversational Analytics agent over a
single table. Verified queries and a glossary constrain answers to real
rows. The orchestrator reaches it through the
`google-cloud-geminidataanalytics` SDK.

Why not query BigQuery directly from the orchestrator? Because the data
agent centralises the "what does the schema mean" logic — the verified
queries, the glossary, the system instruction. That means you can improve
the answers without touching the orchestrator or the web app.

### 5. Firestore (default database)

Four collections, four lifecycles:

| Collection       | Contains                                              | Lifecycle                                                        |
|------------------|-------------------------------------------------------|------------------------------------------------------------------|
| `cache`          | Cached data-agent lookups (currently: the role seed) | Stale after 6 hours; refreshed on next access.                   |
| `working_memory` | One doc per person compiled in a conversation         | **Deleted** when the person's final report is written.           |
| `reports`        | Final salary reports (the structured JSON blocks)     | Persisted. Source of truth for CSV downloads and any dashboards. |
| `audit_log`      | One doc per knowledge-tool call — the question asked, the answer received | TTL: 30 days, then auto-deleted by a Firestore TTL policy on `created_at`. |

`audit_log` is the traceability mechanism made concrete: for any finalized
report, its `reports` doc carries a `session_id`, and every
`query_salary_knowledge` call made during that same session is in
`audit_log` under the same `session_id` — so the figures a real user saw can
be checked against the actual data-agent responses that produced them, not
just trusted on the strength of the system prompt.

## Why the split matters

**Grounding.** The orchestrator has no salary knowledge of its own. It only
knows how to ask the data agent. If the data agent returns nothing, the
orchestrator has nothing to say. That's the correct failure mode for a
salary tool.

**Independence.** Improving the salary answers is a data-agent change:
tweak a verified query, add a glossary term, publish. No redeploy of the
orchestrator, no redeploy of the web app.

**Traceability.** Every figure the user sees is one SQL query away, and —
since `audit_log` exists — the *specific* query that produced it for a
*specific* real conversation is one Firestore lookup away too. That's a
much easier defence than "trust the LLM."

## Why Firestore, not ADK sessions

ADK ships session-service integrations, including Firestore. We use
Firestore differently — as **application memory** rather than session
memory. The distinction:

- ADK sessions store the conversation transcript for a given user across
  turns. On Cloud Run without a configured `--session_service_uri`, ADK
  falls back to in-memory sessions — meaning a redeploy or instance restart
  forgets every in-progress session. The web app's `/api/session` and
  `/api/chat` routes handle this: a "Session not found" response triggers
  a silent replay against a freshly-minted session rather than surfacing an
  error, and a long BigQuery lookup that outlives the SSE connection gets
  picked back up by polling the (still-persisted) Firestore state rather
  than trusting the dropped stream. Both are client-side resilience, not
  changes to how ADK sessions themselves work.
- Application memory (this repo's `working_memory`, `reports`, and
  `audit_log`) stores the **profile** being compiled, the **report**
  produced, and the **evidence** behind it. That data needs to survive
  restarts and is used by the frontend independently of ADK.

Splitting them means the two concerns evolve independently and the data
you actually care about (`reports`, `audit_log`) doesn't get entangled with
ADK's internal session model.

## Two more pipelines, deliberately outside the orchestrator

Neither of these touches salary grounding — they're the web app talking to
Google APIs directly, not through the orchestrator, so a failure in either
never affects report accuracy or the chat itself.

- **Report banner illustration** — see layer 2 above. `/api/banner` on the
  web app, Gemini's image model, entirely optional.
- **GA4 analytics.** `gtag.js` loads client-side (only if
  `NEXT_PUBLIC_GA_MEASUREMENT_ID` is set) and fires a handful of funnel
  events — conversation started, report generated, banner generated,
  report/CSV downloaded. Linking the GA4 property to BigQuery (Admin →
  Product Links → BigQuery Links, a console-only step) exports these events
  into their own `analytics_<property-id>` dataset — a separate dataset
  from wherever the salary data itself lives, not mixed with it.

## What's outside the picture (deliberately)

- **No user accounts.** The demo is anonymous by design; no sign-in, no
  history across visits. If you productise this, add auth.
- **No CI.** The `salary_agent/eval/` harness runs scripted personas
  through the real agent (real Gemini, real BigQuery, real Firestore) and
  asserts on the JSON shape — useful as a manual regression check before
  redeploying a prompt change, not wired into a pipeline that runs it for
  you.
