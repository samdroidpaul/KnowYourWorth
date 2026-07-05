# Troubleshooting

Errors we hit building this, and how to fix them. Ordered roughly by when
they happen in a build.

## Build & deploy

### `Failed to resolve version 20.x for Node.js`
Cloud Buildpacks doesn't currently ship Node 20. Pin `"engines": { "node":
"22.x" }` in `package.json`. As of writing, 22.x, 24.x, and 26.x are
available.

### `container failed to start and listen on the port` (Next.js)
Cloud Run injects `$PORT=8080`. If `next start` runs with its default
(`localhost:3000`), the container binds the wrong port and Cloud Run's
health check kills it. Fix:

```json
"start": "next start -H 0.0.0.0 -p ${PORT:-8080}"
```

Both `-H 0.0.0.0` (bind all interfaces) and the `$PORT` arg matter.

### `Usage: adk deploy cloud_run [OPTIONS] AGENT`
The agent-package path is a required positional argument at the end of the
ADK options. Add `orchestrator` (or your package name) after all the
`--flags`.

### `No such option '--service-account'`
`--service-account` is a `gcloud run deploy` flag, not an ADK flag. Put it
after `--` in the deploy command:

```bash
adk deploy cloud_run --project=... --region=... orchestrator \
  -- \
  --service-account=... --allow-unauthenticated --set-env-vars=...
```

Everything before `--` goes to ADK. Everything after goes to gcloud.

### `Build failed; check build logs for details`
The failure is in Cloud Build. Get the log with:

```bash
gcloud builds log BUILD_ID --region=YOUR_REGION
```

or open the URL `gcloud` prints (mind the trailing `]` that sometimes comes
from copy-paste — trim it).

Common causes: JSON syntax error in `package.json`, a truncated file
during paste (look for "Unexpected eof"), a Node engine that isn't
available (see above).

## Runtime — agent-side

### `403 "User does not have permission to chat."`
The orchestrator's service account can't chat with the published data
agent. Grant:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/geminidataanalytics.dataAgentUser"
```

Also verify **which** SA the service is actually running as — a deploy
that ignored `--service-account` will fall back to the default compute SA,
which also lacks this role:

```bash
gcloud run services describe salary-orchestrator --region=YOUR_REGION \
  --format="value(spec.template.spec.serviceAccountName)"
```

Grant the role to whichever SA is returned.

### `404 ... dataAgents/PASTE_YOUR_AGENT_ID was not found`
`DATA_AGENT_ID` was left as the placeholder from the deploy command. Fix:

```bash
gcloud run services update salary-orchestrator \
  --region=YOUR_REGION \
  --update-env-vars DATA_AGENT_ID=your-real-agent-id
```

The real ID is the last segment of the resource path in the BigQuery
console:
`projects/.../locations/LOCATION/dataAgents/`**`THIS-PART`**.

### `429 RESOURCE_EXHAUSTED`
Gemini quota. On a fresh project, Dynamic Shared Quota puts you in the
lowest tier, and bursty tool-calling turns exceed it easily. Three fixes,
stackable:

1. `retry_options` on the Gemini model (already in this repo's
   `agent.py`) — retries 429/503 with exponential backoff.
2. `thinking_config(thinking_budget=0)` — cuts tokens per turn roughly in
   half, so you trip the limit less.
3. If it keeps happening during a demo, switch to the AI Studio Developer
   API for the model calls only. Set `GOOGLE_GENAI_USE_VERTEXAI=FALSE` and
   `GOOGLE_API_KEY=…`. The data agent still runs through the project;
   only conversation moves to a separate quota pool.

### `PermissionDenied: User does not have permission to access ...`
Locally, `adk web` runs as your `gcloud` user. On Cloud Run, it runs as
the service account. The two identities have different permissions. If it
works locally but fails deployed, the service account is missing a role
the user has. Compare permissions and grant the missing role to the SA.

## Runtime — web-side

### `502 Upstream 403`
The Next.js proxy reached the orchestrator, and the orchestrator returned
403. Three usual causes:

1. **Proxy is using `fetch` instead of `client.request`.** Bare `fetch`
   doesn't attach the ID token. See `web/app/api/session/route.ts` for the
   correct pattern.
2. **Audience mismatch.** `getIdTokenClient` must be called with the
   orchestrator's exact base URL — no trailing slash, no path. Custom
   domains as audience aren't supported.
3. **Runtime SA doesn't have `run.invoker`.** Check both:
   - which SA the web service is running as (`describe … serviceAccountName`)
   - the invoker policy on the orchestrator (`get-iam-policy`)

### `Silent 502` — no error text
The proxy handler is catching an upstream error and returning `502`
without logging the reason. Add `console.error(err)` in every `catch`
block, redeploy, then look at logs:

```bash
gcloud run services logs read salary-web --region=YOUR_REGION --limit=100
```

Note: errors from the handler usually surface at INFO severity, not ERROR.
Don't filter by `severity>=ERROR` when hunting for these.

### `Service [salary-orchestrator] could not be found`
You're running a `gcloud run services update` command before the service
has been deployed. Deploy first, then update.

## Windows Command Prompt quirks

The bash-style guides break in cmd.exe in specific ways. Fixes:

- `export FOO=bar` → `set FOO=bar` — and **do not put a space around the
  `=`**. `set FOO =bar` creates a variable literally named `FOO ` (with a
  trailing space).
- `$VAR` → `%VAR%`.
- `$(command)` (command substitution) has no clean equivalent — capture
  with `for /f`:
  ```bat
  for /f "usebackq delims=" %i in (`gcloud run services describe ...`) do set AGENT_URL=%i
  ```
- `%` in SQL: cmd tries to expand `%nz%` as a variable. Run
  `LIKE '%something%'` queries in the BigQuery web console, not through
  `bq query` in cmd.

## `adk web` warning: "for development purposes"

Expected. The `--with_ui` deploy exposes ADK's dev interface, which shows
raw tool calls and state. Fine for testing; drop `--with_ui` for a
production-only API service.

## Firestore looks empty after deploying

Two possibilities:
1. **The new code hasn't actually deployed.** Check the newest revision's
   timestamp and read `services describe … containers[0].env` — if the
   env vars aren't there, the deploy skipped them.
2. **The model isn't calling the memory tools.** Look at the ADK dev UI
   tool-call chips during a conversation. If `note_person`,
   `get_role_examples`, and `finalize_person` never appear, the system
   instruction isn't pushing the model to use them.

`working_memory` is deleted on every `finalize_person`, so the collection
being empty *between* conversations is normal. Refresh Firestore Studio
mid-interview to see it populated.
