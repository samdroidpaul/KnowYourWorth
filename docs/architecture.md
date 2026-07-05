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
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
            ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
            │  BigQuery    │  │   Gemini     │  │  Firestore   │
            │  data agent  │  │ (Vertex AI)  │  │  (default)   │
            │  the FACTS   │  │  reasoning   │  │  memory      │
            └──────────────┘  └──────────────┘  └──────────────┘
```

## The five layers

### 1. Browser (public)

Talks to the Next.js origin only. No secrets, no direct calls to the
orchestrator, no service-account keys. This is a hard rule — anything the
browser holds is stealable, so it holds nothing sensitive.

### 2. Next.js UI (Cloud Run, public)

Two responsibilities:
- **Serve the SPA.** Chat, streaming, salary table, CSV download.
- **Proxy every backend call.** Both `/api/session` and `/api/chat` run
  server-side, mint an ID token, and forward with the token attached.

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

Three collections, three lifecycles:

| Collection       | Contains                                              | Lifecycle                                                        |
|------------------|-------------------------------------------------------|------------------------------------------------------------------|
| `cache`          | Cached data-agent lookups (currently: the role seed) | Stale after 6 hours; refreshed on next access.                   |
| `working_memory` | One doc per person compiled in a conversation         | **Deleted** when the person's final report is written.           |
| `reports`        | Final salary reports (the structured JSON blocks)     | Persisted. Source of truth for CSV downloads and any dashboards. |

## Why the split matters

**Grounding.** The orchestrator has no salary knowledge of its own. It only
knows how to ask the data agent. If the data agent returns nothing, the
orchestrator has nothing to say. That's the correct failure mode for a
salary tool.

**Independence.** Improving the salary answers is a data-agent change:
tweak a verified query, add a glossary term, publish. No redeploy of the
orchestrator, no redeploy of the web app.

**Traceability.** Every figure the user sees is one SQL query away. That's
a much easier defence than "trust the LLM."

## Why Firestore, not ADK sessions

ADK ships session-service integrations, including Firestore. We use
Firestore differently — as **application memory** rather than session
memory. The distinction:

- ADK sessions store the conversation transcript for a given user across
  turns. On Cloud Run without a configured `--session_service_uri`, ADK
  falls back to in-memory sessions. That's fine for a hackathon.
- Application memory (this repo's `working_memory` and `reports`) stores
  the **profile** being compiled and the **report** produced. That data
  needs to survive restarts and is used by the frontend independently of
  ADK.

Splitting them means the two concerns evolve independently and the data
you actually care about (`reports`) doesn't get entangled with ADK's
internal session model.

## What's outside the picture (deliberately)

- **No user accounts.** The demo is anonymous by design; no sign-in, no
  history across visits. If you productise this, add auth.
- **No analytics wired in.** GA4/BigQuery export and a Looker Studio
  dashboard were sketched in the original design but not shipped. If you
  want a "reports generated" metric, the `reports` collection is your
  source.
- **No image generation.** The original plan included Nano Banana for
  shareable result cards. Not implemented in the reference; small
  addition if you want it.
