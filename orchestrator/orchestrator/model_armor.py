"""
Model Armor safety layer for the orchestrator's model calls.

Wired in as before_model_callback / after_model_callback on the root Agent (see agent.py).
These are content-safety/security checks — prompt injection, jailbreak attempts, sensitive
data, harmful content — layered ON TOP of the existing grounding guarantees (the hard rule
against inventing facts, and the audit_log trail in memory.py). Model Armor has no concept of
"is this salary figure real"; it answers a different question ("is this text dangerous"),
which is why it's a separate, additive layer rather than a replacement for anything else here.

Scoping: only genuine user-authored turns are screened, not the internal follow-up calls ADK
makes after a tool responds. A single interview turn can trigger several tool calls (see the
eval harness — one multi-role persona made 5 query_salary_knowledge calls in one turn), and
each of those triggers its own internal LLM call to process the tool's result. Re-screening
every one of those would multiply latency and cost for zero security benefit — the model's own
tool-result processing isn't user-controlled input. Only the newest Content in the request is
ever a genuine user turn; internal follow-ups carry a function_response part instead.

Fails open: if Model Armor itself errors (misconfigured template, quota, outage), the turn
proceeds unscreened rather than breaking the conversation. A demo dying because a secondary
safety check is temporarily unavailable is a worse outcome than one unscreened turn.

Entirely optional: unset MODEL_ARMOR_TEMPLATE and both callbacks no-op immediately. Safe to
deploy without any Model Armor setup at all.
"""

import logging
import os

import proto
from google.adk.agents.callback_context import CallbackContext
from google.adk.models import LlmRequest, LlmResponse
from google.api_core.client_options import ClientOptions
from google.cloud import modelarmor_v1 as ma
from google.genai import types

logger = logging.getLogger(__name__)

# Not every region works for every project — we hit a project where us-central1
# consistently returned TEMPLATE_NOT_FOUND for a template that genuinely existed
# there, while the same template + same code in australia-southeast2 worked
# immediately. Cause unconfirmed (not a Cloud-Run-region-must-match-template-region
# thing — tested that directly, ruled it out), so treat the location as something to
# verify per-project rather than assume any region works. Test with a direct SDK
# call (see docs/model-armor-monitoring.md) before trusting a new region blindly.
PROJECT_ID = os.environ.get("PROJECT_ID", "")
MODEL_ARMOR_LOCATION = os.environ.get("MODEL_ARMOR_LOCATION", "australia-southeast2")
MODEL_ARMOR_TEMPLATE = os.environ.get("MODEL_ARMOR_TEMPLATE", "")

_client = None


def _enabled() -> bool:
    return bool(PROJECT_ID and MODEL_ARMOR_TEMPLATE)


def _get_client():
    global _client
    if _client is None:
        _client = ma.ModelArmorClient(
            client_options=ClientOptions(
                api_endpoint=f"modelarmor.{MODEL_ARMOR_LOCATION}.rep.googleapis.com"
            )
        )
    return _client


def _template_name() -> str:
    return (
        f"projects/{PROJECT_ID}/locations/{MODEL_ARMOR_LOCATION}"
        f"/templates/{MODEL_ARMOR_TEMPLATE}"
    )


def _latest_user_text(llm_request: LlmRequest) -> str | None:
    """The newest genuinely user-authored text turn, or None if the newest turn in the
    request is an internal tool-response follow-up rather than real user input."""
    contents = llm_request.contents or []
    if not contents:
        return None
    last = contents[-1]
    parts = last.parts or []
    if any(p.function_response is not None for p in parts):
        return None  # this turn is a tool result being fed back, not user input
    text = "".join(p.text or "" for p in parts)
    return text or None


def _refusal(text: str) -> LlmResponse:
    return LlmResponse(
        content=types.Content(role="model", parts=[types.Part(text=text)])
    )


def _match_summary(filter_results) -> str:
    """Which filter(s) actually matched, as plain text — not a raw proto object.
    logger.warning("%s", <proto message>) prints an opaque MapComposite repr by
    default, which defeats the whole point of this being a log a human reads.

    filter_results is a map of category name -> FilterResult, where each FilterResult
    has exactly one populated nested *_filter_result field (malicious_uri_filter_result,
    sdp_filter_result, rai_filter_result, pi_and_jailbreak_filter_result,
    csam_filter_filter_result), each carrying its own match_state.
    """
    match_found = int(ma.FilterMatchState.MATCH_FOUND)
    try:
        matched = []
        for category, result in dict(filter_results).items():
            inner = next(iter(proto.Message.to_dict(result).values()), {})
            if inner.get("match_state") == match_found:
                confidence = inner.get("confidence_level")
                label = ma.DetectionConfidenceLevel(confidence).name if confidence else None
                matched.append(f"{category}(confidence={label})" if label else category)
        return f"matched: {', '.join(matched)}" if matched else "no filter matched"
    except Exception:
        return repr(filter_results)


def before_model_callback(
    callback_context: CallbackContext, llm_request: LlmRequest
) -> LlmResponse | None:
    """Screen genuine user input before it reaches Gemini. Returning an LlmResponse here
    replaces the model call entirely — the real request never goes out."""
    if not _enabled():
        return None
    text = _latest_user_text(llm_request)
    if not text:
        return None
    try:
        result = _get_client().sanitize_user_prompt(
            request=ma.SanitizeUserPromptRequest(
                name=_template_name(), user_prompt_data=ma.DataItem(text=text)
            )
        ).sanitization_result
    except Exception:
        logger.exception("Model Armor sanitize_user_prompt failed; proceeding unscreened")
        return None
    if result.filter_match_state == ma.FilterMatchState.MATCH_FOUND:
        logger.warning(
            "Model Armor blocked a user prompt: %s", _match_summary(result.filter_results)
        )
        return _refusal(
            "I can't help with that request. Let's get back to talking about your work "
            "and market worth."
        )
    return None


def after_model_callback(
    callback_context: CallbackContext, llm_response: LlmResponse
) -> LlmResponse | None:
    """Screen Gemini's outgoing response before it streams to the user. Skips partial
    streaming chunks — only the completed response is worth screening."""
    if not _enabled() or llm_response.partial or not llm_response.content:
        return None
    text = "".join(p.text or "" for p in (llm_response.content.parts or []))
    if not text:
        return None
    try:
        result = _get_client().sanitize_model_response(
            request=ma.SanitizeModelResponseRequest(
                name=_template_name(), model_response_data=ma.DataItem(text=text)
            )
        ).sanitization_result
    except Exception:
        logger.exception("Model Armor sanitize_model_response failed; proceeding unscreened")
        return None
    if result.filter_match_state == ma.FilterMatchState.MATCH_FOUND:
        logger.warning(
            "Model Armor blocked a model response: %s", _match_summary(result.filter_results)
        )
        return _refusal(
            "I wasn't able to complete that response safely. Could you rephrase, or we "
            "can continue from where we left off?"
        )
    return None
