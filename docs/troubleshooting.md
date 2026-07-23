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

### Redeploying the orchestrator quietly reopens it to the public
The `adk deploy cloud_run` example in `orchestrator/README.md` includes
`--allow-unauthenticated` because that's the right flag for a *first*
deploy. Running that exact command again on an already-locked-down service
adds an `allUsers` invoker binding back — `gcloud` only *adds* IAM bindings
on deploy, it never removes existing ones, so this silently undoes the
lockdown from `security.md` without any error or warning. Drop
`--allow-unauthenticated` from the command once the service is locked down;
existing invoker bindings (the web SA, your own account) are untouched
either way. Verify after any redeploy:

```bash
gcloud run services get-iam-policy salary-orchestrator --region=YOUR_REGION
```

`allUsers` should not appear in the `run.invoker` binding.

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

### A multi-role report's percentages sum to way over 100 (e.g. 1000%)
Happens when the agent is asked to compare the *same* role across several
locations ("what would a Data Analyst earn in Sydney vs Melbourne vs
Perth") and treats each location as if it were a slice of one person's
week, assigning each an artificial `pct`. The original system instruction
never defined what `pct` means precisely enough to rule this out. Fixed by
adding an explicit rule to the system instruction: `pct` is share of one
person's *week*, must sum to ~100 for a single person, and a genuine
multi-location comparison should report each location as its own `pct:
100` result rather than splitting a week across locations. Verified with
the eval harness (`salary_agent/eval/run_eval.py`) — an 8-role,
multi-location persona that used to total 1000% now totals exactly 100,
and dropped from 7 conversation turns to 1 after also batching the
interview questions in the same prompt revision.

## Model Armor

### `TEMPLATE_NOT_FOUND` for a template that genuinely exists
The single most time-consuming issue we hit. A template created and
visible in the console, in a region that appeared in the region picker,
still failed with `TEMPLATE_NOT_FOUND` on every API/SDK call — same error
from three different callers (local machine, the deployed Cloud Run
service, and a direct SDK call explicitly targeting the matching regional
endpoint), so it isn't a caller-location, endpoint-host-format, or
resource-path-format issue (all three were tested and ruled out directly).
The same template configuration in a *different* region worked immediately
with zero other changes — including called from a Cloud Run service that
stayed in a third, different region the whole time, ruling out "caller and
template must be in the same region" too. We never fully root-caused why
one specific region failed for this project and another didn't. **Fix:**
don't assume any region works — verify with a direct SDK call before
wiring a template into anything:

```python
from google.cloud import modelarmor_v1 as ma
from google.api_core.client_options import ClientOptions
client = ma.ModelArmorClient(client_options=ClientOptions(api_endpoint='modelarmor.YOUR_REGION.rep.googleapis.com'))
result = client.sanitize_user_prompt(request=ma.SanitizeUserPromptRequest(
    name='projects/YOUR_PROJECT/locations/YOUR_REGION/templates/YOUR_TEMPLATE',
    user_prompt_data=ma.DataItem(text='hello world'),
))
print(result.sanitization_result.filter_match_state)   # 1 = NO_MATCH_FOUND = it works
```

If this fails, try a different region before spending time on anything
else — see [`model-armor-monitoring.md`](model-armor-monitoring.md) for
the full setup and verification flow.

### Model Armor block log shows `<proto.marshal.collections.maps.MapComposite object at 0x...>`
`filter_results` on a `SanitizationResult` is a proto map field, not a
message — passing it straight to `logger.warning("%s", result.filter_results)`
prints Python's default repr for the wrapper object, not anything useful.
Each entry in the map is itself a `FilterResult` with exactly one populated
nested `*_filter_result` field (`pi_and_jailbreak_filter_result`,
`rai_filter_result`, etc.), each with its own `match_state`. Iterate the map,
convert each value with `proto.Message.to_dict()`, and pull out whichever
category actually matched — see `_match_summary()` in
`orchestrator/model_armor.py` for the working version. Confirmed output:
`matched: pi_and_jailbreak(confidence=HIGH)`.

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

### The chat SSE stream dies mid-conversation, no error shown
Node's default `fetch` kills a response body that goes idle for 5 minutes —
and a BigQuery data-agent lookup can easily run that long silently while
the orchestrator "thinks." The chat proxy route needs to use `undici`
directly with idle timeouts disabled rather than the platform default
`fetch`:

```ts
import { Agent, fetch as undiciFetch } from "undici";
const streamAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
// ...
await undiciFetch(url, { ...opts, dispatcher: streamAgent });
```

Even with this fixed, treat a dropped connection as recoverable, not fatal
— see the next entry.

### A report never arrives, even though the conversation looked complete
ADK sessions are in-memory on Cloud Run without a configured
`--session_service_uri` (see `architecture.md`) — a connection can drop
while the agent is still working, especially on a long BigQuery lookup,
and the finished report has nowhere live to stream back to. The fix isn't
"never drop a connection" (you can't guarantee that), it's recovering after
one does: when a stream ends without a report, poll the ADK session's
persisted event history (`GET .../sessions/{id}`) for up to ~2 minutes and
pull the finished report in from there once it lands, rather than treating
the dropped stream as a failure.

### `Session not found` (404) shortly after a redeploy
Same root cause as above — in-memory ADK sessions don't survive a
redeploy or instance restart, so a browser tab holding an old `session_id`
in `sessionStorage` starts getting 404s. Fix client-side: catch the
specific "Session not found" error, silently create a fresh session, and
replay the last message once — don't surface this to the user as an error.

### Streamed assistant messages appear duplicated
ADK's SSE stream sends incremental chunks flagged `partial: true`, then
re-sends the turn's *complete* text in one final aggregate event with
`partial` unset. Appending every chunk's text (partial and final alike)
onto one buffer duplicates the whole message. Keep completed turns
separate from the in-flight partial buffer, and let each final event
*replace* the partial buffer rather than appending to it.

### Gemini image call for the report banner returns `429`
Unlike Gemini's text models, `gemini-2.5-flash-image` (and image models
generally) have **no free tier at all** on Vertex AI — a fresh API key
without a billing account linked will 429 on the very first call,
regardless of how little you've used it. Link a billing account to the
project behind the key (Google AI Studio → API key → the linked GCP
project → Billing). At $0.039/image, this is a few cents even for heavy
testing. The banner feature is designed to fail silently either way — a
429 here never breaks report generation or the chat, it just means no
image renders.

### `[object Object]` where a config value (e.g. an env var) should be
Specific to Next.js App Router: a Server Component (e.g. `layout.tsx`)
importing a plain constant — not a React component — from a file marked
`"use client"` gets an opaque client-reference proxy object instead of the
actual value, because the whole module's exports are treated as client
references once the boundary is crossed. It doesn't error; it just silently
stringifies as `[object Object]` wherever it's used (a template literal, a
prop). Fix: read the value directly in the Server Component (e.g.
`process.env.YOUR_VAR` inline) instead of importing it from a `"use
client"` module — don't cross the boundary for anything that isn't a
component being rendered as JSX.

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
- Reading a single value out of a `.env.local`-style file (e.g. an API key
  for a deploy command) without ever printing the secret into the visible
  command: combine `findstr` with `for /f` and a `tokens=2 delims==` split:
  ```bat
  for /f "usebackq tokens=2 delims==" %B in (`findstr /b "GEMINI_API_KEY=" .env.local`) do set GEMINI_KEY=%B
  ```
  Then reference `%GEMINI_KEY%` in the deploy command itself. Only works
  cleanly when the value has no `=` in it, which API keys generally don't.
- `%` in SQL: cmd tries to expand `%nz%` as a variable. Run
  `LIKE '%something%'` queries in the BigQuery web console, not through
  `bq query` in cmd.
- The single-`%` loop-variable syntax above (`%i`, `%B`) is for typing
  directly into an interactive cmd.exe session. Saved into a `.bat` file,
  every loop variable needs doubling (`%%i`, `%%B`) or the script errors.

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
mid-interview to see it populated. `audit_log`, unlike `working_memory`,
is never deleted by the app itself — only by its 30-day TTL policy — so an
empty `audit_log` means the code writing to it hasn't been deployed yet,
not that it was cleaned up.
