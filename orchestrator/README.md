# Orchestrator

The conversation layer. An ADK (Agent Development Kit) agent, packaged into a
container, running on Cloud Run. Uses Gemini for reasoning, calls the
BigQuery data agent for every fact, and stores per-conversation state in
Firestore.

Nothing in this README hard-codes hosting details. Every value with a
`your-` prefix or `%VAR%` is a placeholder you set to your own.

## What's in this folder

```
orchestrator/
└── orchestrator/          the ADK agent package
    ├── __init__.py        `from . import agent`
    ├── agent.py           defines `root_agent`
    ├── tools.py           the six tools the agent uses
    ├── memory.py          Firestore helpers
    ├── requirements.txt   Python deps (pinned SDK version)
    └── .env.example       template for local env vars
```

The `agent.py` module exposes a `root_agent` variable — that's the entry
point ADK looks for. Everything else is called from tools.

## Design in one paragraph

The agent has **six tools**. One knowledge tool that reaches out to the
BigQuery data agent (`query_salary_knowledge`), one cached seed lookup for
the "I'm unsure of my title" case (`get_role_examples`), and four Firestore
tools that build up a per-person profile during the interview and clear it
once a final report is written (`note_person`, `recall_person`,
`list_people`, `finalize_person`). The system instructions enforce a hard
rule: no role or salary figure may appear in a response unless it came back
from one of the two knowledge tools. The model does conversation and
percentage-of-week reasoning; the data agent does facts.

## Prerequisites

You need to have completed [`data-agent/README.md`](../data-agent/README.md)
first. Specifically you need:

- Project ID
- Data agent location (probably `global`)
- Data agent ID

APIs enabled:

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  cloudbuild.googleapis.com \
  bigquery.googleapis.com \
  firestore.googleapis.com \
  geminidataanalytics.googleapis.com
```

A Firestore database in Native mode (default DB id `(default)`):

```bash
gcloud firestore databases create --location=YOUR_REGION
```

## Step 1 — Create the orchestrator's service account

The orchestrator runs as its own identity so IAM stays tight.

```bash
gcloud iam service-accounts create salary-agent-sa \
  --display-name="Salary orchestrator"
```

Grant the roles it needs. Substitute your project ID and use the SA email
`salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com`:

```bash
# Talk to Gemini + Nano Banana on Vertex/Agent Platform
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# Read the BigQuery tables behind the data agent + run queries
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer"
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/bigquery.jobUser"

# Read/write Firestore
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/datastore.user"

# CHAT with the published data agent (the one people forget)
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/geminidataanalytics.dataAgentUser"
```

The last one is the trap: without `geminidataanalytics.dataAgentUser`, every
`query_salary_knowledge` call returns `403 "User does not have permission to
chat."` The other BigQuery roles are not enough on their own.

## Step 2 — Test locally

Copy the env template and fill it in:

```bash
cp orchestrator/.env.example orchestrator/.env
```

Edit `.env` — you need real values for `PROJECT_ID`, `DATA_AGENT_LOCATION`,
`DATA_AGENT_ID`, and the two `GOOGLE_*` variables.

Install deps and authenticate:

```bash
pip install -r orchestrator/requirements.txt
gcloud auth application-default login
```

`adk web` opens a local development UI that talks to your real data agent
and Firestore (using *your* credentials, not the service account). From the
folder that contains the `orchestrator/` package:

```bash
adk web
```

Pick `orchestrator` from the dropdown and chat. Two things confirm it's
working:

- The chat produces a coherent interview that ends with a fenced JSON block.
- Firestore Studio shows a `working_memory` doc appearing during the
  interview and a `reports` doc appearing when the final block is written.

If either fails, the ADK dev UI shows tool-call chips inline that tell you
which tool errored.

## Step 3 — Deploy to Cloud Run

`adk deploy cloud_run` packages the agent, builds a container via Cloud
Build, pushes to Artifact Registry, and rolls out a Cloud Run revision. The
`--` separator matters: everything after it is passed straight to
`gcloud run deploy`, so that's where the service account and env vars go.

```bash
adk deploy cloud_run \
  --project=YOUR_PROJECT_ID \
  --region=YOUR_REGION \
  --service_name=salary-orchestrator \
  --with_ui \
  orchestrator \
  -- \
  --service-account=salary-agent-sa@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --allow-unauthenticated \
  --set-env-vars=GOOGLE_GENAI_USE_VERTEXAI=TRUE,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,GOOGLE_CLOUD_LOCATION=global,PROJECT_ID=YOUR_PROJECT_ID,DATA_AGENT_LOCATION=global,DATA_AGENT_ID=YOUR_PUBLISHED_DATA_AGENT_ID
```

Things that trip up first-time deploys:
- The **agent path** (`orchestrator`) at the end of the ADK options is
  required. Without it: `Usage: adk deploy cloud_run [OPTIONS] AGENT`.
- `--service-account` is a **gcloud** flag, not an ADK flag, so it must go
  after `--`.
- Your local `.env` is **not** pushed to Cloud Run. The env vars must be set
  with `--set-env-vars`. `tools.py` reads them at import time, so a missing
  var crashes startup.

`--with_ui` deploys the ADK dev UI as a testing surface. Fine for a
demo. For production, drop `--with_ui` and point your Next.js app at the
API-only service.

## Step 4 — Update an already-running service

Config changes without a full redeploy:

```bash
# Change a single env var
gcloud run services update salary-orchestrator \
  --region=YOUR_REGION \
  --update-env-vars DATA_AGENT_ID=NEW_ID

# Tune scaling / cost caps (min 1 removes cold starts; max caps burst spend)
gcloud run services update salary-orchestrator \
  --region=YOUR_REGION \
  --min-instances=1 \
  --max-instances=3 \
  --cpu-boost \
  --concurrency=40

# See what env vars are set
gcloud run services describe salary-orchestrator \
  --region=YOUR_REGION \
  --format="value(spec.template.spec.containers[0].env)"

# See what SA the service is running as
gcloud run services describe salary-orchestrator \
  --region=YOUR_REGION \
  --format="value(spec.template.spec.serviceAccountName)"

# Read logs (real errors surface at INFO, not ERROR — no severity filter)
gcloud run services logs read salary-orchestrator --region=YOUR_REGION --limit=100
```

## The six tools, at a glance

Full docstrings live in `tools.py`. Quick summary:

| Tool                     | Purpose                                                     |
|--------------------------|-------------------------------------------------------------|
| `query_salary_knowledge` | Ask the data agent anything. All facts come through here.   |
| `get_role_examples`      | Cached seed list of common items for the "unsure" case.     |
| `note_person`            | Save a learned fact into per-person working memory.         |
| `recall_person`          | Read back what's been gathered for a person.                |
| `list_people`            | List everyone being compiled in this conversation.          |
| `finalize_person`        | Save the final report; clear working memory for that person.|

## Resilience settings worth knowing

- `retry_options` retries the Gemini call on 429 / 503 with exponential
  backoff. On a fresh project, DSQ tier is low; without retries you'll see
  intermittent quota errors during demos.
- `thinking_config(thinking_budget=0)` disables the model's internal
  "thinking" tokens. Roughly halves latency and per-turn cost. Fine for an
  interview workload; enable it if you switch to a reasoning-heavy task.
- `max_output_tokens=1024` caps each response. The final JSON block is
  small; long prose responses are a sign the model is off-piste.

## Next

Move on to [`web/README.md`](../web/README.md) to deploy the public UI.
Then apply the lockdown in [`docs/security.md`](../docs/security.md) so
only the web SA can call this service.
