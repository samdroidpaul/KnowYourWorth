# Web UI

Next.js 14 (App Router) app that hosts the chat surface, streams the
conversation from the orchestrator, and renders the final JSON block as a
salary table with a CSV download.

The full UI is not included in this section — only the two API route
handlers that do the work most people get wrong. Those two files (`session`
and `chat`) are what actually make the whole architecture safe. Everything
else you can build to taste.

## Why the routes matter more than the UI

The browser must **never** call the orchestrator directly. It's locked down
to reject anonymous traffic. Instead, the browser calls **your own Next.js
origin**, and the two route handlers below run server-side, mint a
Google-signed ID token for the orchestrator's audience, and forward the
request with the token attached.

This means:
- No secrets in the client bundle.
- No CORS to fight — the browser only sees its own origin.
- The orchestrator only ever sees traffic from the Next.js service account.

## What's in this folder

```
web/
├── app/
│   └── api/
│       ├── session/route.ts    Session create + fetch (POST + GET)
│       └── chat/route.ts       Streaming chat (POST /run_sse)
├── package.json                pinned Node engine, scripts wired for Cloud Run
└── .env.local.example          template for local dev
```

You add: the UI (pages, components, styling). Recommended stack — React + a
lightweight state library, EventSource for SSE, and a small parser that
watches for a fenced JSON block in the streamed assistant messages and
renders the salary table.

## Prerequisites

- The **orchestrator is deployed** ([`orchestrator/README.md`](../orchestrator/README.md))
  and you have its public URL. Get it with:
  ```bash
  gcloud run services describe salary-orchestrator \
    --region=YOUR_REGION \
    --format="value(status.url)"
  ```
  No trailing slash, no path.
- Node **22.x** locally. Google Cloud Buildpacks currently ships 22, not 20
  — pinning `"engines": { "node": "22.x" }` in `package.json` prevents drift.
- Next.js 14 App Router.

## Step 1 — Create the web service account

The web app runs as its own identity, distinct from the orchestrator's.
This is what makes the lockdown targetable: only this SA gets invoker rights.

```bash
gcloud iam service-accounts create salary-web-sa \
  --display-name="Salary web UI"
```

## Step 2 — Grant it permission to call the orchestrator

**Do this BEFORE the lockdown.** During deploy the ID token will be minted,
sent, and needs to succeed on first request; if the SA doesn't yet have
invoker, the first call 403s and you'll waste time debugging what looks
like a code issue.

```bash
gcloud run services add-iam-policy-binding salary-orchestrator \
  --region=YOUR_REGION \
  --member="serviceAccount:salary-web-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

## Step 3 — Test locally

```bash
cp .env.local.example .env.local
# edit .env.local — set AGENT_SERVICE_URL to your orchestrator's URL
npm install
npm run dev
```

Local dev is a special case: `google-auth-library` on a laptop can't mint ID
tokens from your regular `gcloud auth application-default login`. Two
options:

1. **Keep the orchestrator `--allow-unauthenticated`** while you iterate
   locally, then lock it down after deploy.
2. **Impersonate the web SA** for local dev:
   ```bash
   gcloud auth application-default login \
     --impersonate-service-account=salary-web-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com
   ```
   You need `roles/iam.serviceAccountTokenCreator` on the SA for this.

Option 1 is simpler for a hackathon.

## Step 4 — Deploy to Cloud Run

Capture the orchestrator URL into a shell variable so the deploy sets it as
`AGENT_SERVICE_URL`. From this `web/` folder:

```bash
# grab the orchestrator URL
export AGENT_URL=$(gcloud run services describe salary-orchestrator \
  --region=YOUR_REGION --format="value(status.url)")

gcloud run deploy salary-web \
  --source . \
  --region=YOUR_REGION \
  --allow-unauthenticated \
  --service-account=salary-web-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --set-env-vars=AGENT_SERVICE_URL=$AGENT_URL,AGENT_APP_NAME=orchestrator
```

The build uses Google Cloud Buildpacks, which reads `package.json` and runs
`npm run build` + `npm run start`. Two package.json details make this work:

- `"engines": { "node": "22.x" }` — Buildpacks currently only ships 22.x,
  24.x, 26.x. Pinning 20.x fails with a "version constraint not satisfied"
  error.
- `"start": "next start -H 0.0.0.0 -p ${PORT:-8080}"` — Cloud Run injects
  `$PORT=8080` and requires the container to bind on `0.0.0.0`. `next start`'s
  default (`localhost:3000`) makes Cloud Run think the container failed to
  start.

## Step 5 — Verify then lock

Open the deployed web URL and start a conversation. If a full report comes
back, you're ready to lock the orchestrator down. See
[`docs/security.md`](../docs/security.md) for the ordered lockdown runbook.

If the web app returns a 502 after the lockdown, the most likely cause is
that the proxy code isn't attaching the token. The routes in this folder
handle it correctly — using `client.request(...)` from
`google-auth-library`, and for the chat route, minting the token manually
and attaching it to an `undici` request so the SSE stream survives long
silent waits.

## The two routes, explained

### `session/route.ts` — create + fetch ADK sessions

POST creates a new session (`/apps/{app}/users/{userId}/sessions`); GET
fetches an existing session (`/apps/{app}/users/{userId}/sessions/{sessionId}`).
Both use `google-auth-library`'s built-in HTTP client, which handles the
token mint and attachment automatically.

Notable choices:
- `getIdTokenClient(base)` is called with the **base URL only**. The `aud`
  claim of the token has to match this exactly, so path segments would
  break auth.
- `validateStatus: () => true` lets non-2xx bubble up as `res.status` so we
  can log them, rather than throwing.
- Every failure path calls `console.error` — the silent-502 problem
  otherwise wastes hours.

### `chat/route.ts` — stream ADK `/run_sse`

The chat call is a long-lived Server-Sent Events stream. Node's default
`fetch` will kill a stream that goes idle for 5 minutes, which happens
easily while the BigQuery data agent is thinking. So this route:
- Uses `undici` directly with `Agent({ headersTimeout: 0, bodyTimeout: 0 })`
  to disable idle timeouts.
- Mints the ID token manually with
  `client.idTokenProvider.fetchIdToken(audience)` and attaches it as
  `Authorization: Bearer …`. Mixing `google-auth-library`'s HTTP client
  with an SSE stream doesn't work well; separating the concerns does.
- Streams the upstream body straight to the response — the browser parses
  SSE frames itself. This preserves ADK tool-call events without needing
  to know their shape.

## What the frontend needs to do

Build to taste. The essentials:

- POST `/api/session` with a persistent per-browser `userId` (a UUID in
  `localStorage` is fine). Save the returned `sessionId`.
- For each user message, POST `/api/chat` with `{ userId, sessionId,
  message }` and treat the response as an SSE stream. Show the streamed
  tokens as they arrive.
- Watch for a fenced JSON block whose payload has a `roles` array.
  When you see one, render a salary table (Role, %, Low, Mid, High) and
  offer a CSV download built from the same JSON.
- Show a "thinking…" pill during `function_call` events. Don't display the
  raw tool names — this is a public UI, not a debugger.
- Add a footer: *"Estimates for negotiation preparation, not financial advice."*

The strict rule: **never modify the numbers**. Currency, range values,
percentages — render exactly what the JSON says. The agent's guarantee is
that every figure traces to a BigQuery row. Rewriting them locally breaks
that guarantee.
