# Web UI

Next.js 14 (App Router) app that hosts the chat surface, streams the
conversation from the orchestrator, and renders the final JSON block as a
salary table with a CSV/HTML report download. This is the complete app as
deployed — chat UI, video backdrop, theming, GA4 analytics, OG share image,
and the optional AI-generated report banner — not a stripped-down reference.

## Why the API routes matter

The browser must **never** call the orchestrator directly. It's locked down
to reject anonymous traffic. Instead, the browser calls **your own Next.js
origin**, and `app/api/session` + `app/api/chat` run server-side, mint a
Google-signed ID token for the orchestrator's audience, and forward the
request with the token attached.

This means:
- No secrets in the client bundle.
- No CORS to fight — the browser only sees its own origin.
- The orchestrator only ever sees traffic from the Next.js service account.

`app/api/banner` is a different case — it doesn't call the orchestrator at
all, so it has no ID-token auth. It calls Google's Gemini image API directly
with a plain API key (`GEMINI_API_KEY`), same as any external API call a
Next.js server route might make. It's designed to fail soft: no key, a quota
error, an empty response — all of them return `{ image: null }` rather than
an error, so a decorative feature can never break the actual product.

## What's in this folder

```
web/
├── app/
│   ├── page.tsx                 The chat page — layout, state, scroll behaviour
│   ├── layout.tsx                Root layout, metadata, GA4 script, theme bootstrap
│   ├── globals.css               Tailwind base + custom animations
│   ├── opengraph-image.tsx       Dynamically generated OG share image
│   └── api/
│       ├── session/route.ts      Session create + fetch (POST + GET)
│       ├── chat/route.ts         Streaming chat (POST /run_sse)
│       └── banner/route.ts       Optional report banner illustration (POST)
├── components/
│   ├── Chat.tsx                  SSE parsing, session self-healing, /demo accelerator,
│   │                             banner request/wait logic, GA4 event tracking
│   ├── Message.tsx               Renders a single chat message (markdown-aware)
│   ├── SalaryTable.tsx           Role / % / low / mid / high table from the JSON block
│   ├── SalaryChart.tsx           Recharts visualisation of the same data
│   ├── Header.tsx                Mobile ring vs desktop progress bar
│   ├── Backdrop.tsx               Canvas backdrop
│   ├── VideoBackdrop.tsx         Crossfading stock-footage backdrop
│   ├── ThemeToggle.tsx           Light/dark toggle
│   ├── ThinkingPill.tsx          "Thinking…" indicator during tool calls
│   └── BannerLoading.tsx         Rotating loading messages while the banner generates
├── lib/
│   ├── types.ts                  Shared TS types for the report JSON shape
│   ├── parseResult.ts            Extracts the fenced JSON block from streamed text,
│   │                             weightedAverages() for multi-role/location reports
│   ├── csv.ts                    CSV export
│   ├── report.ts                 buildReportHtml() / downloadReport() — the HTML report
│   ├── session.ts                localStorage-backed userId/sessionId persistence
│   └── analytics.ts              trackEvent() wrapper around gtag.js
├── public/videos/                Stock footage for the backdrop (Mixkit, free-licence)
├── package.json                  pinned Node engine, scripts wired for Cloud Run
└── .env.local.example            template for local dev
```

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
# edit .env.local — set AGENT_SERVICE_URL to your orchestrator's URL.
# GEMINI_API_KEY, NEXT_PUBLIC_SITE_URL, and NEXT_PUBLIC_GA_MEASUREMENT_ID
# are all optional — leave any of them unset and that feature (banner
# illustration, OG share image, analytics) is simply off. Nothing else
# is affected.
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

# Optional extras, added the same way any time after the first deploy:
gcloud run services update salary-web \
  --region=YOUR_REGION \
  --update-env-vars=GEMINI_API_KEY=YOUR_KEY,NEXT_PUBLIC_SITE_URL=YOUR_DEPLOYED_URL,NEXT_PUBLIC_GA_MEASUREMENT_ID=G-YOUR_ID
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

## The three API routes, explained

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

### `banner/route.ts` — optional report illustration

Takes the finished report's roles and location, builds a prompt for the
dominant role, and calls `gemini-2.5-flash-image` directly with
`GEMINI_API_KEY`. No orchestrator involved, no ID token — this is a
plain server-side API call, the simplest of the three routes.

Notable choices:
- Every failure path — no key configured, a bad request, a non-2xx from
  Gemini, a response with no image data, a thrown exception — returns
  `{ image: null, reason: "..." }` with a normal 200, never an error
  status. The frontend's job is just: got an image, show it; didn't,
  don't. A decorative feature should never be able to break report
  generation.
- `gemini-2.5-flash-image` (and image models generally) had **no free
  tier** as of writing — a key with no billing account linked 429s on the
  very first call, not after some quota is used up. See
  [`docs/troubleshooting.md`](../docs/troubleshooting.md) if this bites you.
- The prompt explicitly asks for no text/numbers/logos in the image —
  image models otherwise like to render garbled text into illustrations,
  which reads as broken rather than stylistic.

## How the chat UI works

`components/Chat.tsx` is the core: it POSTs to `/api/session` once per
browser (persisting `userId`/`sessionId` via `lib/session.ts`), then for
each turn POSTs to `/api/chat` and reads the SSE stream. Partial-token
events are buffered separately from the final aggregate event so text
never doubles. Once a streamed message contains a complete fenced JSON
block, `lib/parseResult.ts` extracts it, `SalaryTable.tsx`/`SalaryChart.tsx`
render it, and the user can download a CSV (`lib/csv.ts`) or a styled HTML
report (`lib/report.ts`). If a stale session 404s (e.g. after a redeploy —
ADK sessions are in-memory and don't survive restarts), `Chat.tsx`
transparently creates a fresh session and replays the last message once.

The strict rule the whole UI honours: **never modify the numbers**.
Currency, range values, percentages — render exactly what the JSON says.
The agent's guarantee is that every figure traces to a BigQuery row.
Rewriting them locally breaks that guarantee.
