# Know Your Worth

A public-facing conversational agent that helps AU/NZ workers walk into a pay
conversation with data, not guesswork. It interviews the user about the work
they do each week, matches that to real job roles in a curated dataset, and
returns a downloadable report showing which roles they perform, what percentage
of their week each takes, and the low / median / high salary band for each in
their location.

Every figure is traceable to a row in BigQuery. Nothing is invented — and every
conversation's grounding is preserved for 30 days in an audit trail, so that's
checkable after the fact for any real report, not just a claim about the
system prompt.

## What's in this repo

This is a reference implementation you can fork and adapt. The salary use case
is the running example, but the pattern generalises to any domain where you
have (a) a structured knowledge source in BigQuery and (b) a conversation that
needs to be grounded in it.

```
know-your-worth/
├── data-agent/       BigQuery dataset + Conversational Analytics agent
├── orchestrator/     ADK agent on Cloud Run (the conversation layer)
├── web/              Next.js UI on Cloud Run (the public surface)
├── eval/             Local eval harness — scripted personas through the real agent
├── docs/             Architecture, security model, troubleshooting, Model Armor monitoring
└── README.md         You are here.
```

## Architecture in one paragraph

Two agents, one job each. A BigQuery Conversational Analytics agent owns the
facts. An ADK orchestrator on Cloud Run owns the conversation. A hard rule in
the orchestrator's system instructions forbids stating any role or figure that
did not come back from a tool call to the data agent — and every one of those
calls is logged to Firestore's `audit_log`, so that rule is checkable, not just
declared. A Next.js app on Cloud Run is the only public entry point; it mints
a Google-signed ID token server-side and forwards to the locked-down
orchestrator. An optional Model Armor layer screens every prompt and response
for prompt injection, jailbreak attempts, and harmful content, failing open if
it's ever unavailable. Firestore holds a seed cache, per-person working
memory, finalized reports, and that audit trail.

```
Browser  →  Next.js UI (Cloud Run, public)  →  [signed ID token]
        →  Orchestrator (Cloud Run, locked to the web SA only)
        →  BigQuery data agent  (sole source of facts)
        →  Gemini               (conversation + reasoning, screened by Model Armor if configured)
        →  Firestore            (cache, working_memory, reports, audit_log)

Next.js UI also calls, independently of the orchestrator:
        →  Gemini image model   (optional report banner illustration)
        →  GA4 → BigQuery       (funnel analytics, a separate dataset)
```

See [`docs/architecture.md`](docs/architecture.md) for the full picture, and
[`docs/model-armor-monitoring.md`](docs/model-armor-monitoring.md) for the
safety-layer setup.

## Quickstart

Prerequisites: a Google Cloud project with billing enabled, `gcloud` CLI
authenticated, and Python 3.11+ / Node 22+ available locally (or use Cloud
Shell, which has both).

Build order matters — later steps depend on values produced by earlier ones:

1. **Enable APIs and create the data agent** — [`data-agent/README.md`](data-agent/README.md).
   You need a working, published BigQuery data agent with its ID recorded
   before the orchestrator can call it.
2. **Deploy the orchestrator** — [`orchestrator/README.md`](orchestrator/README.md).
   Uses ADK to package a Python agent into a container and ships it to Cloud
   Run. Requires the data agent's ID from step 1.
3. **Verify it before you build on it** — `eval/run_eval.py` runs a handful of
   scripted personas straight through the real agent (real Gemini, real
   BigQuery, real Firestore) and asserts on the JSON shape. From the repo
   root: `python -m eval.run_eval`. Cheap regression check before *and*
   after any prompt change — the harness is also what measured the
   7-turns-to-1-turn improvement from batching the interview questions.
4. **Deploy the web UI** — [`web/README.md`](web/README.md). Next.js app that
   proxies to the orchestrator with server-side ID-token auth.
5. **Lock it down** — [`docs/security.md`](docs/security.md). Remove public
   access to the orchestrator; only the web SA should be able to call it.
6. **Optional: turn on the Model Armor safety layer** —
   [`docs/model-armor-monitoring.md`](docs/model-armor-monitoring.md). Screens
   every prompt and response for prompt injection, jailbreak attempts, and
   harmful content; alerts on a block. Skip this step and the orchestrator
   behaves identically — it's off by default and fails open if misconfigured.
7. **Read the runbook** — [`docs/troubleshooting.md`](docs/troubleshooting.md).
   Every error we hit and how we fixed it.

## What this repo doesn't include

- **Any real project ID, service account, or URL.** Every hosting-specific
  value is a placeholder you replace with your own.
- **The salary dataset.** You bring your own. `data-agent/` describes the
  schema shape that works well with this pattern; the actual rows are up to
  you.
- **Sign-in for end users.** The public surface is anonymous by design (a
  hackathon demo, not a product). If you productise this, put auth in front
  of the web UI.

## Licence

 MIT 

## Credit

Built for the Gen AI Academy APAC hackathon.
