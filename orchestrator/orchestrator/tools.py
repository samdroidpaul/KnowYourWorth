"""
Tools for the orchestrator.

Knowledge (the ONLY source of role/salary facts):
  - query_salary_knowledge : ask the published BigQuery data agent anything.
  - get_role_examples      : cached seed list of roles (speed win).

Per-person session memory (Firestore-backed):
  - note_person     : accumulate a fact about a person being compiled.
  - recall_person   : read back what's been gathered about a person.
  - list_people     : list everyone in progress in this conversation.
  - finalize_person : save the final report, then clear that person's
                      working memory.

Verified against google-cloud-geminidataanalytics 0.13.1.
"""

import os
import json
from google.cloud import geminidataanalytics as gda
from google.protobuf.json_format import MessageToDict
from google.adk.tools import ToolContext

from . import memory

PROJECT_ID = os.environ["PROJECT_ID"]
DATA_AGENT_LOCATION = os.environ.get("DATA_AGENT_LOCATION", "global")
DATA_AGENT_ID = os.environ["DATA_AGENT_ID"]

_client = None


def _get_client():
    global _client
    if _client is None:
        _client = gda.DataChatServiceClient()
    return _client


def _row_to_dict(row):
    try:
        return MessageToDict(row._pb)
    except Exception:
        return {"_raw": str(row)}


def _ask_data_agent(question: str) -> str:
    client = _get_client()
    parent = f"projects/{PROJECT_ID}/locations/{DATA_AGENT_LOCATION}"
    request = gda.ChatRequest(
        parent=parent,
        data_agent_context=gda.DataAgentContext(
            data_agent=f"{parent}/dataAgents/{DATA_AGENT_ID}",
        ),
        messages=[gda.Message(user_message=gda.UserMessage(text=question))],
    )
    out = []
    for message in client.chat(request=request):
        sm = message.system_message
        if sm.text and sm.text.parts:
            out.append("".join(sm.text.parts))
        if sm.data and sm.data.result and sm.data.result.data:
            rows = [_row_to_dict(r) for r in sm.data.result.data]
            out.append("DATA: " + json.dumps(rows, default=str))
        if sm.error and sm.error.text:
            out.append("ERROR: " + sm.error.text)
    return "\n".join(out).strip() or "(the data agent returned no answer)"


def _session_id(tool_context: ToolContext) -> str:
    sess = getattr(tool_context, "session", None)
    return getattr(sess, "id", None) or tool_context.invocation_id


# --------------------------------------------------------------------------
# Knowledge tools
# --------------------------------------------------------------------------
def query_salary_knowledge(question: str) -> str:
    """Look up job roles, responsibilities, and AU/NZ salary ranges from the
    published BigQuery data agent. This is the ONLY trustworthy source of role
    and salary facts — never answer salary or role questions without it.

    Args:
        question: a plain-language question for the data agent.
    Returns:
        The data agent's answer as text, possibly with a "DATA:" line of
        JSON rows.
    """
    return _ask_data_agent(question)


def get_role_examples(tool_context: ToolContext) -> str:
    """Return a cached list of common roles and their typical tasks, to
    suggest to a user who is unsure of their title. Uses a Firestore cache so
    the data agent is queried at most once every few hours instead of every
    conversation.
    """
    cached = memory.cache_get("role_seed")
    if cached:
        return cached
    answer = _ask_data_agent(
        "List the most common job roles and a short description of their "
        "typical day-to-day tasks. Keep it concise."
    )
    memory.cache_set("role_seed", answer)
    return answer


# --------------------------------------------------------------------------
# Per-person session memory tools
# --------------------------------------------------------------------------
def note_person(person_label: str, note: str, tool_context: ToolContext) -> str:
    """Save a fact learned about a specific person while compiling their
    profile. Call this each time you learn something (a task, tool, seniority
    detail, hours split, etc.).
    """
    memory.add_note(_session_id(tool_context), person_label, note)
    return f"Noted for {person_label}."


def recall_person(person_label: str, tool_context: ToolContext) -> str:
    """Return everything gathered so far about a person in this conversation."""
    rec = memory.get_person(_session_id(tool_context), person_label)
    if not rec:
        return f"No notes yet for {person_label}."
    notes = rec.get("notes", [])
    return f"{person_label} (status: {rec.get('status')}):\n- " + "\n- ".join(notes)


def list_people(tool_context: ToolContext) -> str:
    """List the people being compiled in this conversation and their status."""
    people = memory.list_session_people(_session_id(tool_context))
    if not people:
        return "No people in progress yet."
    return "\n".join(
        f"- {p.get('label')}: {p.get('status')} ({len(p.get('notes', []))} notes)"
        for p in people
    )


def finalize_person(person_label: str, report_json: str, tool_context: ToolContext) -> str:
    """Record the final salary report for a person (the significant output),
    then CLEAR that person's working memory. Call this once you have produced
    the final result for them.
    """
    try:
        report = json.loads(report_json)
    except Exception:
        report = {"raw": report_json}
    memory.finalize(_session_id(tool_context), person_label, report)
    return f"Saved the report for {person_label} and cleared their working memory."
