"""
Local eval harness for the "Know Your Worth" orchestrator agent.

Runs a handful of scripted personas straight through the real agent
in-process (real Gemini calls, real BigQuery data agent, real Firestore
working memory) — no Cloud Run deploy needed. Useful two ways:

  1. Regression check before redeploying a prompt change: run it, make sure
     nothing broke, then deploy with confidence.
  2. A/B measurement: the number of turns-to-report is printed per persona,
     so a prompt change aimed at shortening the interview (e.g. batching
     questions) has a concrete before/after number instead of a vibe.

Usage:
    From the repo root:
    python -m eval.run_eval

Requires the same environment as the deployed agent: GOOGLE_CLOUD_PROJECT,
PROJECT_ID, DATA_AGENT_ID etc. — this script loads
orchestrator/orchestrator/.env the same way `adk web` would, via
python-dotenv if available, else expects the vars already exported in the
shell.

Each eval writes real (small) data to Firestore's working_memory/reports
collections, same as a real user session would — that's intentional, it's
the real integration path, not a mock.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field

# The importable `orchestrator` package lives at orchestrator/orchestrator/
# (each top-level section of this repo gets its own folder), so the path
# entry needed for `import orchestrator` to resolve is repo_root/orchestrator,
# not the repo root itself.
sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "orchestrator"),
)

try:
    from dotenv import load_dotenv

    load_dotenv(
        os.path.join(os.path.dirname(__file__), "..", "orchestrator", "orchestrator", ".env")
    )
except ImportError:
    pass

from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from orchestrator.agent import root_agent

APP_NAME = "orchestrator-eval"
MAX_TURNS = 6
FOLLOW_UP = (
    "I've told you everything I can about my role — please go ahead and "
    "give me the report now with what you have."
)
FENCE_RE = re.compile(r"```json\s*([\s\S]*?)```")


@dataclass
class Persona:
    name: str
    opening: str


@dataclass
class EvalResult:
    persona: str
    turns_to_report: int | None = None
    roles: list[dict] = field(default_factory=list)
    currency: str | None = None
    location: str | None = None
    summary: str = ""
    tool_calls: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    elapsed_s: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.errors and self.turns_to_report is not None


PERSONAS = [
    Persona(
        "senior-swe-nz",
        "I'm a senior software engineer in New Zealand with 8 years of experience, "
        "mostly Python and AWS, mentoring two juniors and leading the platform "
        "team's roadmap.",
    ),
    Persona(
        "data-scientist-aus",
        "I'm a data scientist based in Sydney with 5 years experience, working "
        "with Python, SQL and dbt, and I split my week between modelling work "
        "and stakeholder workshops.",
    ),
    Persona(
        "multi-role-nz",
        "I work as a programmer for 10% of the week, a Database Admin / designer "
        "for 20% of the week, a Security engineer for 20%, a Security tester for "
        "20%, and an AI engineer/designer/architect for the rest. I've worked at "
        "this level for 8 years and have over 20 years of experience overall. "
        "What are my salary prospects in New Zealand?",
    ),
]


def extract_report(text: str) -> dict | None:
    for match in reversed(FENCE_RE.findall(text)):
        try:
            parsed = json.loads(match.strip())
            if isinstance(parsed.get("roles"), list) and parsed["roles"]:
                return parsed
        except (json.JSONDecodeError, AttributeError):
            continue
    return None


def check_report(report: dict, result: EvalResult) -> None:
    result.currency = report.get("currency")
    result.location = report.get("location")
    result.roles = report.get("roles", [])

    if not result.currency:
        result.errors.append("no currency field")
    if not result.location:
        result.errors.append("no location field")
    if not result.roles:
        result.errors.append("no roles in report")

    total_pct = sum(r.get("pct", 0) for r in result.roles)
    if total_pct > 130:
        result.errors.append(
            f"pct total is {total_pct} (>130) — looks like the multi-location "
            f"comparison bug, not a real week split"
        )

    for r in result.roles:
        title = r.get("title", "?")
        low, mid, high = r.get("low"), r.get("mid"), r.get("high")
        if None in (low, mid, high):
            result.errors.append(f"{title}: missing low/mid/high")
            continue
        if not (low <= mid <= high):
            result.errors.append(f"{title}: low/mid/high out of order ({low}/{mid}/{high})")

    if result.summary and not result.summary.rstrip().endswith((".", "!", "?", '"')):
        result.errors.append("summary looks truncated (doesn't end in sentence punctuation)")


async def run_persona(persona: Persona, session_service: InMemorySessionService) -> EvalResult:
    result = EvalResult(persona=persona.name)
    start = time.monotonic()

    session = await session_service.create_session(
        app_name=APP_NAME, user_id=f"eval-{persona.name}"
    )
    runner = Runner(agent=root_agent, app_name=APP_NAME, session_service=session_service)

    message_text = persona.opening
    accumulated_final_text = ""
    report = None

    for turn in range(1, MAX_TURNS + 1):
        content = types.Content(role="user", parts=[types.Part(text=message_text)])
        turn_text = ""
        try:
            async for event in runner.run_async(
                user_id=session.user_id, session_id=session.id, new_message=content
            ):
                for call in event.get_function_calls() or []:
                    result.tool_calls.append(call.name)
                if event.content and event.content.parts:
                    for part in event.content.parts:
                        if getattr(part, "text", None):
                            turn_text += part.text
        except Exception as e:  # noqa: BLE001 — surface any failure as an eval error
            result.errors.append(f"turn {turn}: exception {type(e).__name__}: {e}")
            break

        accumulated_final_text = turn_text
        report = extract_report(turn_text)
        if report:
            result.turns_to_report = turn
            result.summary = FENCE_RE.sub("", turn_text).strip()
            break

        message_text = FOLLOW_UP

    if report:
        check_report(report, result)
    elif not result.errors:
        result.errors.append(
            f"no report within {MAX_TURNS} turns (last reply: "
            f"{accumulated_final_text[:120]!r}…)"
        )

    result.elapsed_s = time.monotonic() - start
    return result


def print_report(results: list[EvalResult]) -> bool:
    all_ok = True
    print("\n" + "=" * 78)
    print(f"{'persona':<20} {'turns':<7} {'roles':<7} {'pct sum':<9} {'time':<7} status")
    print("-" * 78)
    for r in results:
        pct_sum = sum(role.get("pct", 0) for role in r.roles)
        status = "PASS" if r.ok else "FAIL"
        all_ok &= r.ok
        print(
            f"{r.persona:<20} {str(r.turns_to_report or '-'):<7} "
            f"{len(r.roles):<7} {pct_sum:<9} {r.elapsed_s:<6.1f}s {status}"
        )
        for err in r.errors:
            print(f"    ! {err}")
        if r.ok:
            print(f"    tools used: {', '.join(r.tool_calls) or '(none)'}")
    print("=" * 78)
    print("ALL PASS" if all_ok else "FAILURES ABOVE")
    return all_ok


async def main() -> int:
    session_service = InMemorySessionService()
    results = [await run_persona(p, session_service) for p in PERSONAS]
    ok = print_report(results)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
