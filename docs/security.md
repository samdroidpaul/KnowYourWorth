# Security & lockdown

The orchestrator is deployed `--allow-unauthenticated` during initial setup
so you can iterate. Before you share the URL, close that off — this section
walks through the ordered steps.

**Order matters.** Doing the lockdown before the web app can mint a valid
token gives you a service that rejects your own frontend. Doing it after
the web app is deployed and proven to work is safe.

## Threat model

- **Stop:** anyone with the orchestrator URL calling it directly.
- **Also stop:** a compromised frontend leaking a token that grants direct
  agent access (the token is never in the browser).
- **Doesn't stop:** users of your public web app spamming the interview.
  For that add per-IP rate limiting on the Next.js side. Cloud Armor if
  you put an HTTPS load balancer in front, `@upstash/ratelimit` or similar
  at the app layer otherwise.
- **Doesn't stop:** cost from legitimate abuse. Keep `max-instances` low
  and set a billing budget alert.

## Ordered runbook

Prerequisites:
- Orchestrator deployed and currently `--allow-unauthenticated`.
- Web app deployed, running as `salary-web-sa`, and confirmed working
  end-to-end.

### Step 1 — Confirm the web SA has invoker

Should already be true from `web/README.md` step 2. Verify:

```bash
gcloud run services get-iam-policy salary-orchestrator --region=YOUR_REGION
```

You want the `roles/run.invoker` binding to include
`serviceAccount:salary-web-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com`.

### Step 2 — Prove the token path works while the door is still open

Open the deployed web URL and have a real conversation to the point of a
final report. This confirms the Next.js proxy is minting tokens and
attaching them, so when we close the door in step 3 the frontend keeps
working.

Do NOT skip this. The browser test after step 3 doesn't prove anything by
itself — the browser hits the web origin, which is still public. If the
proxy silently isn't attaching a token, closing the door breaks the site.

### Step 3 — Remove public access

`gcloud run services update` doesn't accept `--no-allow-unauthenticated`
in older CLI versions, but the direct IAM equivalent works everywhere:

```bash
gcloud run services remove-iam-policy-binding salary-orchestrator \
  --region=YOUR_REGION \
  --member="allUsers" \
  --role="roles/run.invoker"
```

If the binding wasn't there, you'll get a "does not exist" error — harmless,
it means the door was already closed.

### Step 4 — Verify from an unauthenticated position

The web app must still work AND direct traffic must fail. Both are needed.

```bash
# Web app: open in a browser and start a conversation. Should work.

# Direct: capture the orchestrator URL and curl it. Should 403.
export AGENT_URL=$(gcloud run services describe salary-orchestrator \
  --region=YOUR_REGION --format="value(status.url)")
curl -i $AGENT_URL/list-apps
```

You want `HTTP/2 403` on the curl. Anything else means the lockdown didn't
stick — go back to step 3.

### Step 5 (optional) — Network-layer belt

IAM alone is enough. If you want defence in depth, restrict ingress so the
orchestrator URL isn't reachable from the internet at all:

```bash
gcloud run services update salary-orchestrator \
  --region=YOUR_REGION \
  --ingress=internal-and-cloud-load-balancing
```

`salary-web` is in the same project so it still reaches through the
internal path. External `curl` calls no longer even reach the URL to be
rejected. If the web UI stops working after this, revert with
`--ingress=all` and troubleshoot.

## Rollback

To reopen the orchestrator quickly:

```bash
gcloud run services update salary-orchestrator \
  --region=YOUR_REGION \
  --allow-unauthenticated \
  --ingress=all

# then re-add allUsers to the invoker binding
gcloud run services add-iam-policy-binding salary-orchestrator \
  --region=YOUR_REGION \
  --member="allUsers" \
  --role="roles/run.invoker"
```

The `run.invoker` binding on the web SA is harmless to leave in place — it
does nothing on an unauthenticated service but is already correct for
when you re-lock.

## Ongoing hygiene

- **Rotate service accounts if a credential leaks.** ID tokens are minted
  fresh on every request from the metadata server, so there are no long-
  lived keys to rotate. But if you ever add a JSON key (don't), rotate.
- **Watch invoker bindings.** If someone else in the project accidentally
  grants `run.invoker` on the orchestrator to another account, the
  lockdown weakens. `get-iam-policy` regularly.
- **Set a billing budget** with an email alert before the URL is public.
  A budget doesn't stop spend — it warns — but it's the fastest signal
  something has gone wrong. Real caps come from `max-instances` and a
  BigQuery daily quota, not from the budget itself.
