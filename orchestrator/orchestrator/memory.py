"""
Firestore-backed helpers for the orchestrator.

Three collections, three jobs:
  cache           - cached lookups (e.g. the item-seed list) to avoid re-
                    querying the data agent every session.
  working_memory  - one doc per person being compiled, scoped to the
                    conversation session.
  reports         - finalized outputs, kept after working memory is cleared.

The deployed service account needs roles/datastore.user; PROJECT_ID is set as
an env var.
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


# --------------------------------------------------------------------------
# Cache (speed win): store a value with a timestamp; treat as stale after TTL.
# --------------------------------------------------------------------------
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


# --------------------------------------------------------------------------
# Per-person working memory, scoped to a session.
# --------------------------------------------------------------------------
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
