"""
Firestore-backed helpers for the orchestrator.

Four collections, four jobs:
  cache           - cached lookups (the role-seed list) to avoid re-querying the data agent.
  working_memory  - one doc per person being compiled, scoped to the conversation session.
  reports         - finalized outputs, kept after the working memory is cleared.
  audit_log       - one doc per knowledge-tool call (question asked, answer received),
                    scoped to the session. Kept forever, independent of working_memory's
                    lifecycle.

Why audit_log exists: the hard rule against hallucination lives in the system prompt, which
is a claim about behaviour, not proof of it. audit_log is the proof — every figure in a
`reports` doc should be traceable to a query_salary_knowledge call in `audit_log` for the same
session_id. Without it, "the agent can't hallucinate" can only be checked by re-testing it
yourself; with it, any real user's conversation can be checked after the fact.

The deployed service account already has roles/datastore.user, and PROJECT_ID is set as an
env var, so no extra config is needed.
"""

import os
import time
from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

_db = None


def _client():
    global _db
    if _db is None:
        _db = firestore.Client(project=os.environ.get("PROJECT_ID"))
    return _db


def _slug(label: str) -> str:
    s = "".join(c.lower() if c.isalnum() else "-" for c in (label or "")).strip("-")
    return s or "person"


# ----------------------------------------------------------------------------
# Cache (speed win): store a value with a timestamp; treat it as stale after TTL.
# ----------------------------------------------------------------------------
CACHE_TTL_SECONDS = 6 * 3600


def cache_get(key: str):
    snap = _client().collection("cache").document(key).get()
    if snap.exists:
        d = snap.to_dict()
        if time.time() - float(d.get("updated_at", 0)) < CACHE_TTL_SECONDS:
            return d.get("value")
    return None


def cache_set(key: str, value: str):
    _client().collection("cache").document(key).set(
        {"value": value, "updated_at": time.time()}
    )


# ----------------------------------------------------------------------------
# Per-person working memory, scoped to a session.
# ----------------------------------------------------------------------------
def _wm_ref(session_id: str, label: str):
    return _client().collection("working_memory").document(f"{session_id}__{_slug(label)}")


def add_note(session_id: str, label: str, note: str):
    _wm_ref(session_id, label).set(
        {
            "session_id": session_id,
            "label": label,
            "status": "in_progress",
            "notes": firestore.ArrayUnion([note]),
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def get_person(session_id: str, label: str):
    snap = _wm_ref(session_id, label).get()
    return snap.to_dict() if snap.exists else None


def list_session_people(session_id: str):
    q = _client().collection("working_memory").where(
        filter=FieldFilter("session_id", "==", session_id)
    )
    return [s.to_dict() for s in q.stream()]


def finalize(session_id: str, label: str, report) -> None:
    """Persist the report, then delete the person's working-memory doc."""
    _client().collection("reports").add(
        {
            "session_id": session_id,
            "label": label,
            "report": report,
            "created_at": firestore.SERVER_TIMESTAMP,
        }
    )
    _wm_ref(session_id, label).delete()


# ----------------------------------------------------------------------------
# Audit log: every knowledge-tool call, kept forever. This is the grounding
# evidence a `reports` doc can be checked against.
# ----------------------------------------------------------------------------
MAX_AUDIT_RESPONSE_CHARS = 4000  # keep docs small; plenty to verify a claim against


def log_tool_call(session_id: str, tool: str, request: str, response: str) -> None:
    """Record one knowledge-tool call (question in, answer out) against a session.
    Never raises — a logging failure must not break the conversation.
    """
    try:
        _client().collection("audit_log").add(
            {
                "session_id": session_id,
                "tool": tool,
                "request": request,
                "response": (response or "")[:MAX_AUDIT_RESPONSE_CHARS],
                "truncated": len(response or "") > MAX_AUDIT_RESPONSE_CHARS,
                "created_at": firestore.SERVER_TIMESTAMP,
            }
        )
    except Exception:
        pass


def get_audit_log(session_id: str):
    """Every knowledge-tool call made during a session, oldest first — the grounding
    trail for whatever ended up in that session's `reports` docs."""
    q = (
        _client()
        .collection("audit_log")
        .where(filter=FieldFilter("session_id", "==", session_id))
        .order_by("created_at")
    )
    return [s.to_dict() for s in q.stream()]
