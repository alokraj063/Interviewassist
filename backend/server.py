"""
Interview Assist — backend.

A thin WebSocket proxy:
  browser audio (linear16 PCM @ 16 kHz)  ->  Deepgram Flux  ->  live transcripts

One browser WebSocket == one audio source ("interviewer" or "candidate").
We open a dedicated Deepgram Flux connection per source, so speaker labels are
exact (no diarization guessing). The Deepgram API key never leaves the backend.

Docs: https://developers.deepgram.com/docs/flux/quickstart
"""

import asyncio
import io
import json
import os
import re
import uuid
from pathlib import Path
from urllib.parse import urlencode

import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI
from starlette.responses import RedirectResponse

import db

load_dotenv()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-3")
DEEPGRAM_LANGUAGE = os.getenv("DEEPGRAM_LANGUAGE", "en")
DEEPGRAM_ENDPOINTING = os.getenv("DEEPGRAM_ENDPOINTING", "300")
PORT = int(os.getenv("PORT", "3001"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY) if OPENAI_API_KEY else None

# In production: serve the Vite build at frontend/dist.
# In dev: developers run Vite on :5173 (it proxies /api, /assist, /stream to here).
_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIST = _ROOT / "frontend" / "dist"
FRONTEND_DIR = FRONTEND_DIST if FRONTEND_DIST.exists() else None
TRANSCRIPT_DIR = _ROOT / "transcripts"
TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Interview Assist")
db.init_db()  # create data.db tables if missing (idempotent)


@app.middleware("http")
async def redirect_zero_host(request, call_next):
    """Bounce 0.0.0.0 (uvicorn's printed link) to localhost — a secure context where
    the browser actually exposes mic/screen capture. 127.0.0.1 / LAN IPs are left as-is."""
    host = request.headers.get("host", "")
    if host.startswith("0.0.0.0"):
        url = request.url.replace(netloc=host.replace("0.0.0.0", "localhost"))
        return RedirectResponse(str(url), status_code=307)
    response = await call_next(request)
    # Dev tool on localhost — never let the browser serve stale HTML/JS/CSS so
    # frontend edits always take effect on a normal refresh.
    response.headers["Cache-Control"] = "no-store"
    return response


def deepgram_url(diarize: bool = False) -> str:
    params = {
        "model": DEEPGRAM_MODEL,
        "language": DEEPGRAM_LANGUAGE,
        "encoding": "linear16",
        "sample_rate": "16000",
        "channels": "1",
        "interim_results": "true",
        "smart_format": "true",
        "punctuate": "true",
        "endpointing": DEEPGRAM_ENDPOINTING,
        # Word-gap based turn end — fires even with continuous mic noise, where the
        # VAD-driven speech_final does not. Keeps the Interviewer side from clubbing.
        "utterance_end_ms": "1000",
    }
    if diarize:
        # Phone mode: one mixed-mono mic carries both voices. Live diarization lets
        # us split the stream into per-speaker turns. Best-effort on mixed mono.
        params["diarize"] = "true"
    qs = urlencode(params)
    return f"wss://api.deepgram.com/v1/listen?{qs}"


@app.get("/health")
async def health():
    return {"ok": bool(DEEPGRAM_API_KEY), "model": DEEPGRAM_MODEL}


def _safe_session(raw: str) -> str:
    s = re.sub(r"[^\w\-.]", "_", (raw or "").strip()) or "session"
    return s[:64]


def _append_turn(session: str, speaker: str, text: str, time: str) -> None:
    """Append one finalized turn to the per-session .txt and .jsonl (runs in a thread)."""
    txt = TRANSCRIPT_DIR / f"interview_{session}.txt"
    jsonl = TRANSCRIPT_DIR / f"interview_{session}.jsonl"
    if not txt.exists():
        txt.write_text(f"# Interview transcript — {session}\n\n", encoding="utf-8")
    with txt.open("a", encoding="utf-8") as f:
        f.write(f"[{time}] {speaker}: {text}\n")
    with jsonl.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"time": time, "speaker": speaker, "text": text}) + "\n")


@app.post("/transcript")
async def save_transcript(req: Request):
    """Persist a finalized turn live. Called once per turn by the frontend."""
    data = await req.json()
    text = (data.get("text") or "").strip()
    if not text:
        return {"ok": True, "skipped": True}
    session = _safe_session(data.get("session", "session"))
    speaker = (data.get("speaker") or "Speaker").strip()
    time = (data.get("time") or "").strip()
    await asyncio.to_thread(_append_turn, session, speaker, text, time)
    return {"ok": True, "file": f"interview_{session}.txt"}


# ---------------------------------------------------------------------------
# Clients / JDs / Interviews  (SQLite-backed; see db.py)
# ---------------------------------------------------------------------------
@app.get("/api/clients")
async def api_list_clients():
    return {"ok": True, "clients": await asyncio.to_thread(db.list_clients)}


@app.post("/api/clients")
async def api_create_client(req: Request):
    data = await req.json()
    name = (data.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "Client name is required."}
    return {"ok": True, "client": await asyncio.to_thread(db.create_client, name)}


@app.get("/api/jds")
async def api_list_jds(client_id: str | None = None):
    return {"ok": True, "jds": await asyncio.to_thread(db.list_jds, client_id)}


@app.post("/api/jds")
async def api_create_jd(
    title: str = Form(""),
    client_id: str = Form(""),
    jd_text: str = Form(""),
    jd_file: UploadFile | None = File(None),
):
    title = title.strip()
    if not title:
        return {"ok": False, "error": "JD title is required."}
    text = (jd_text or "").strip()
    if jd_file is not None:
        # Reuse the same PDF/DOCX/TXT extractor as /assist/start.
        text = (extract_text(jd_file.filename, await jd_file.read()) + "\n" + text).strip()
    jd = await asyncio.to_thread(db.create_jd, client_id or None, title, text)
    return {"ok": True, "jd": jd}


@app.get("/api/jds/{jd_id}")
async def api_get_jd(jd_id: str):
    jd = await asyncio.to_thread(db.get_jd, jd_id)
    return {"ok": bool(jd), "jd": jd}


@app.post("/api/interviews")
async def api_create_interview(req: Request):
    data = await req.json()
    interview = await asyncio.to_thread(
        db.create_interview,
        data.get("client_id") or None,
        data.get("jd_id") or None,
        data.get("candidate_name") or "",
        data.get("call_mode") or "vc",
    )
    return {"ok": True, "interview": interview}


@app.post("/api/interviews/{interview_id}/end")
async def api_end_interview(interview_id: str):
    await asyncio.to_thread(db.end_interview, interview_id)
    # Free the per-interview in-memory state so long-running servers don't leak.
    _drop_session(interview_id)
    return {"ok": True}


@app.get("/api/interviews")
async def api_list_interviews(client_id: str | None = None, jd_id: str | None = None):
    rows = await asyncio.to_thread(db.list_interviews, client_id, jd_id)
    return {"ok": True, "interviews": rows}


@app.get("/api/interviews/{interview_id}")
async def api_get_interview(interview_id: str):
    row = await asyncio.to_thread(db.get_interview, interview_id)
    return {"ok": bool(row), "interview": row}


# ---------------------------------------------------------------------------
# Interview co-pilot (OpenAI GPT-4o-mini)
# ---------------------------------------------------------------------------
FIELD_KEYS = [
    "current_position", "current_company", "current_location",
    "current_salary", "expected_salary",
]

# ---- Multi-user safety ----------------------------------------------------
# ASSIST_SESSIONS is in-memory, keyed by the interview id. Each running interview
# (one recruiter, one candidate) has its own entry, so concurrent interviews never
# touch each other's keys. To make read-modify-write blocks (extending fields,
# merging start+plan into the same session) safe against bursts of requests from
# the SAME interview, we serialise per-session with an asyncio.Lock.
ASSIST_SESSIONS: dict[str, dict] = {}
_SESSION_LOCKS: dict[str, asyncio.Lock] = {}


def _session_lock(session_id: str) -> asyncio.Lock:
    lock = _SESSION_LOCKS.get(session_id)
    if lock is None:
        lock = asyncio.Lock()
        _SESSION_LOCKS[session_id] = lock
    return lock


def _drop_session(session_id: str) -> None:
    """Free in-memory state for a finished interview so the dicts can't grow forever."""
    if not session_id:
        return
    ASSIST_SESSIONS.pop(session_id, None)
    _SESSION_LOCKS.pop(session_id, None)


def _blank_fields() -> dict:
    return {k: "" for k in FIELD_KEYS}


def extract_text(filename: str, data: bytes) -> str:
    """Extract plain text from an uploaded PDF / DOCX / TXT. Returns '' on failure."""
    name = (filename or "").lower()
    try:
        if name.endswith(".pdf"):
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            text = "\n".join((page.extract_text() or "") for page in reader.pages)
        elif name.endswith(".docx"):
            from docx import Document
            doc = Document(io.BytesIO(data))
            text = "\n".join(p.text for p in doc.paragraphs)
        else:
            text = data.decode("utf-8", errors="ignore")
    except Exception as exc:  # noqa: BLE001
        print(f"[assist] extract_text failed for {filename}: {exc}")
        return ""
    return text.strip()[:15000]  # bound tokens


async def _gpt_json(system: str, user: str) -> dict:
    """Call GPT-4o-mini in JSON mode and return the parsed object (or {} on failure)."""
    resp = await openai_client.chat.completions.create(
        model=OPENAI_MODEL,
        messages=[{"role": "system", "content": system},
                  {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0.3,
    )
    try:
        return json.loads(resp.choices[0].message.content)
    except (ValueError, TypeError, IndexError):
        return {}


START_SYSTEM = (
    "You are a sharp, honest technical-recruiting screener. Given a job description and a "
    "candidate resume, give a CALIBRATED pre-call read of fit — judged ONLY against the JD's "
    "core must-haves. Be evidence-based and skeptical, not flattering.\n"
    "Hard rules:\n"
    "- Do NOT say 'strong' unless the resume clearly evidences the role's core requirements "
    "(relevant skills AND comparable years/seniority). When in doubt, rate lower.\n"
    "- If the JD or resume is missing, thin, or generic (not enough to judge), return "
    'fitVerdict "Not enough info" — never inflate to fill the gap.\n'
    "- Ground every claim in specifics from the JD/resume; prefer concrete gaps over praise.\n"
    "Respond ONLY as JSON with this exact shape:\n"
    '{"fitVerdict": one of "Strong fit"|"Possible fit"|"Weak fit"|"Not enough info", '
    '"summary": str (2-3 sentences: which core must-haves the resume meets vs misses), '
    '"strengths": [up to 3 concrete, evidence-backed strengths vs the JD], '
    '"gaps": [up to 3 concrete missing or unclear must-haves to probe], '
    '"openingQuestions": [2-3 specific questions that probe the gaps or verify resume claims]}.'
)

ANALYZE_SYSTEM = (
    "You are a sharp, honest interview co-pilot helping the interviewer decide FAST whether "
    "this candidate is good or bad. You get the job description, the candidate resume, and the "
    "live transcript so far. Turns are labelled either Interviewer/Candidate (video-call mode) "
    "or generically as Speaker 1/Speaker 2 (phone mode, one mic). When labels are generic, "
    "infer which speaker is the candidate (the one answering questions about their experience).\n"
    "Your job each tick:\n"
    "1. Look at the MOST RECENT interviewer question(s) and the candidate's answer(s). Judge "
    "whether the answer actually ADDRESSED the question and was RELEVANT and CORRECT.\n"
    "2. Flag problems honestly in redFlags: didn't answer / dodged the question, vague or "
    "buzzword-only, contradicts the resume or earlier answers, technically wrong, or "
    "over-claiming. Use [] when there are genuinely none.\n"
    "3. Give a clear recommendation so the interviewer can decide quickly.\n"
    "Calibration: be honest — a weak candidate must read as weak. Keep scores proportional to "
    "EVIDENCE so far; early in the call with little signal, stay modest/neutral and use "
    '"Borderline" rather than inflated numbers. Do not reward confident-but-empty answers.\n'
    "Respond ONLY as JSON with this exact shape:\n"
    '{"recommendation": {"verdict": one of "Strong yes"|"Lean yes"|"Borderline"|"Lean no"|'
    '"Strong no", "rationale": str (1 short sentence)}, '
    '"redFlags": [short concrete watch-outs from the transcript; [] if none], '
    '"score": {"overall": int 0-100, "communication": int 0-100, "relevance": int 0-100, '
    '"depth": int 0-100}, '
    '"feedback": str (1-2 sentences that EXPLICITLY say whether the latest answers addressed '
    "the questions and how strong they were), "
    '"suggestedQuestions": [2-3 next questions targeting the gaps or weak/unverified answers], '
    '"fields": {"current_position": str, "current_company": str, "current_location": str, '
    '"current_salary": str, "expected_salary": str}}.\n'
    "For fields: fill a value ONLY if the candidate has explicitly stated it in the "
    "transcript; otherwise use an empty string. Keep everything concise."
)


PLAN_SYSTEM = (
    "You are an interview architect. Given a candidate's resume (and optional job description), "
    "design a structured, personalized interview plan. Group questions into these categories in "
    "this exact order: 'Skills' (verify the skills/tools the resume claims), "
    "'Technical Deep-Dive' (probe core projects and technical reasoning), and "
    "'Experience' (behavioral / project-impact questions).\n"
    "Hard rules:\n"
    "- Every question must reference SPECIFIC content from the resume — a named technology, a "
    "project, a role, or a claim. No generic 'tell me about a time' questions.\n"
    "- Order from broad to deep within each category — start with verification, then drill in.\n"
    "- 2-3 questions per category, 6-9 total.\n"
    "Respond ONLY as JSON with this exact shape:\n"
    '{"categories": [{"name": str, "questions": [str, ...]}, ...]}.'
)

VERIFY_SYSTEM = (
    "You are a PRACTICAL interview evaluator helping the recruiter judge each answer in real "
    "time. Be FAIR — not harsh. Most real interview answers are imperfect but acceptable, and "
    "the recruiter needs to keep the conversation moving, not interrogate the candidate.\n"
    "Calibration (lean lenient, not strict):\n"
    "  - 'Strong'    = clear, specific, technically sound; concrete example or detail.\n"
    "  - 'Adequate'  = on-topic with at least some real content. THIS IS THE DEFAULT for any "
    "answer that addresses the question and shows the candidate gets it — even briefly. "
    "Mark satisfied=true.\n"
    "  - 'Weak'      = on-topic but genuinely thin — generic, single-sentence, no specifics at "
    "all and clearly hiding lack of knowledge. Only when the recruiter would actually want to "
    "re-probe. Mark satisfied=false.\n"
    "  - 'Vague'     = wandering buzzwords with zero substance. Rare; reserve for true empty "
    "non-answers. satisfied=false.\n"
    "  - 'Off-topic' = answered a different question or refused. satisfied=false.\n"
    "Default to 'Adequate' when in doubt. A correct one-sentence answer is Adequate, not Weak. "
    "Do NOT penalise brevity — penalise only true lack of substance.\n"
    "FEEDBACK STYLE: one short, plain-English sentence a recruiter can scan in a second. Speak "
    "ABOUT the candidate (\"They\" / \"The candidate\"), not to them. Don't echo the question. "
    "Examples:\n"
    "  - \"Specific and accurate — named the exact tools and explained the trade-off.\"\n"
    "  - \"Clear and on-topic, though brief; no concrete example given.\"\n"
    "  - \"Off-topic — talked about a different project than the one asked.\"\n"
    "If verdict is Weak/Vague/Off-topic, suggest ONE probing follow-up specific to what they "
    "actually said. Otherwise followUp is an empty string.\n"
    "Respond ONLY as JSON with this exact shape:\n"
    '{"satisfied": bool, "verdict": one of "Strong"|"Adequate"|"Weak"|"Off-topic"|"Vague", '
    '"feedback": str, "followUp": str}.'
)


@app.post("/assist/plan")
async def assist_plan(
    candidate_name: str = Form(""),
    resume_text: str = Form(""),
    jd_text: str = Form(""),
    interview_id: str = Form(""),
    resume_file: UploadFile | None = File(None),
    jd_file: UploadFile | None = File(None),
):
    """Generate a categorized question plan from the candidate's resume."""
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}

    resume = resume_text.strip()
    jd = jd_text.strip()
    if resume_file is not None:
        resume = (extract_text(resume_file.filename, await resume_file.read()) + "\n" + resume).strip()
    if jd_file is not None:
        jd = (extract_text(jd_file.filename, await jd_file.read()) + "\n" + jd).strip()

    # Reuse saved JD attached to the interview row, if any.
    interview_id = (interview_id or "").strip()
    if not jd and interview_id:
        row = await asyncio.to_thread(db.get_interview, interview_id)
        if row and row.get("jd_id"):
            saved = await asyncio.to_thread(db.get_jd, row["jd_id"])
            if saved:
                jd = (saved.get("jd_text") or "").strip()

    if not resume:
        return {"ok": False, "error": "A candidate resume is required to generate questions."}

    user = (
        f"CANDIDATE NAME: {candidate_name or '(unknown)'}\n\n"
        f"CANDIDATE RESUME:\n{resume}\n\n"
        f"JOB DESCRIPTION:\n{jd or '(none provided)'}"
    )
    result = await _gpt_json(PLAN_SYSTEM, user)
    categories = result.get("categories") or []

    # Stash on the assist session so subsequent verify / analyze calls see the resume.
    # Per-session lock keeps concurrent plan / start / analyze calls for the SAME
    # interview from racing on the read-modify-write below.
    session_id = interview_id or uuid.uuid4().hex
    async with _session_lock(session_id):
        session = ASSIST_SESSIONS.get(session_id) or {"fields": _blank_fields()}
        session["jd"] = jd or session.get("jd", "")
        session["resume"] = resume or session.get("resume", "")
        session.setdefault("fields", _blank_fields())
        ASSIST_SESSIONS[session_id] = session

    return {
        "ok": True,
        "sessionId": session_id,
        "candidateName": (candidate_name or "").strip(),
        "categories": categories,
    }


NEXT_SYSTEM = (
    "You are an interview coach driving the conversation ONE question at a time. You receive: "
    "the JOB DESCRIPTION (the role's must-haves), the CANDIDATE'S RESUME (what they claim), and "
    "the conversation so far (each prior Q has a verdict from the live evaluator). Produce the "
    "single next question to ask the candidate.\n"
    "Hard rules:\n"
    "- Every question MUST be anchored in BOTH the JD and the resume. The interview's job is to "
    "test whether what the resume CLAIMS actually meets what the JD REQUIRES. So each question "
    "should connect a SPECIFIC JD requirement to a SPECIFIC resume claim (e.g. \"The JD asks for "
    "X — your resume says you did Y at Z. Walk me through how you …\"). When the JD is empty, "
    "anchor purely in the resume; when the resume is empty, anchor purely in the JD.\n"
    "- NEVER ask generic questions. If you can't tie the question to a concrete detail from BOTH "
    "documents (or from the candidate's last answer), it's not specific enough — rework it.\n"
    "- Prioritise the JD's MUST-HAVE skills first. Don't burn early questions on resume claims "
    "that aren't relevant to the role.\n"
    "- ROTATE TOPICS. Do NOT keep drilling the same skill / tool / project. After at most 1-2 "
    "questions on a given topic, move to a DIFFERENT JD requirement that hasn't been covered.\n"
    "- Pace through phases in order: 'Opener' (one warm-up tying their background to the role), "
    "'Skills' (verify each JD must-have against the resume — one question per skill), "
    "'Technical Deep-Dive' (drill into a project the resume claims, evaluated against the JD's "
    "depth requirements), 'Experience' (behavioural / impact that the JD calls out). Switch "
    "phases when the current one has enough signal.\n"
    "- Only use 'Follow-up' if the LAST answer was Weak / Vague / Off-topic AND the topic is "
    "genuinely worth probing once more. Don't follow up more than once on the same topic; if "
    "they couldn't answer, MOVE ON to a different JD requirement.\n"
    "- After ~6-9 substantive Q&As covering the JD's main must-haves with reasonable topic "
    "spread, OR when there's enough signal to decide, set done=true with question=\"\".\n"
    "Respond ONLY as JSON with this exact shape:\n"
    '{"category": one of "Opener"|"Skills"|"Technical Deep-Dive"|"Experience"|"Follow-up"|"Wrap-up", '
    '"question": str (empty if done), "done": bool}.'
)


@app.post("/assist/next")
async def assist_next(req: Request):
    """Return the single next question to ask, given resume + JD + conversation history."""
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}
    data = await req.json()
    session = ASSIST_SESSIONS.get(data.get("sessionId", "")) or {}
    history = data.get("history") or []

    parts = []
    for i, h in enumerate(history, 1):
        cat = (h.get("category") or "").strip() or "?"
        verdict = (h.get("verdict") or "—").strip()
        q = (h.get("question") or "").strip()
        ans = (h.get("answer") or "").strip()
        parts.append(f"Q{i} [{cat}] (verdict: {verdict}): {q}\nA{i}: {ans}")
    history_text = "\n\n".join(parts) or "(none — this is the opener)"

    user = (
        f"JOB DESCRIPTION:\n{session.get('jd') or '(none)'}\n\n"
        f"CANDIDATE RESUME:\n{session.get('resume') or '(none)'}\n\n"
        f"CONVERSATION SO FAR:\n{history_text}"
    )
    result = await _gpt_json(NEXT_SYSTEM, user)
    return {
        "ok": True,
        "category": (result.get("category") or "").strip(),
        "question": (result.get("question") or "").strip(),
        "done": bool(result.get("done")),
    }


FINAL_SYSTEM = (
    "You are a senior interview evaluator producing the FINAL evaluation of a candidate after "
    "the interview is complete. You receive: the job description, the candidate's resume, and "
    "the full interview transcript (every Q with its answer and the live evaluator's verdict).\n"
    "Be honest and calibrated — don't inflate, don't deflate. Ground every claim in something "
    "the candidate actually said. If the interview was very short, lower confidence and prefer "
    "'Borderline' over a strong verdict.\n"
    "Score each dimension on 0-100:\n"
    "  - communication: clarity, structure, conciseness.\n"
    "  - relevance:     answered the questions asked, not adjacent topics.\n"
    "  - depth:         concrete examples, technical detail, real understanding.\n"
    "  - skills_match:  alignment of demonstrated skills with the JD's must-haves.\n"
    "  - overall:       your overall hire-recommendation score (NOT just the average).\n"
    "Respond ONLY as JSON with this exact shape:\n"
    '{"score": {"overall": int, "communication": int, "relevance": int, "depth": int, '
    '"skills_match": int}, '
    '"verdict": one of "Strong Hire"|"Hire"|"Lean Hire"|"Borderline"|"Lean No Hire"|"No Hire", '
    '"summary": str (2-3 sentences explaining the score), '
    '"strengths": [up to 3 concrete strengths grounded in the conversation], '
    '"concerns": [up to 3 concrete concerns or gaps grounded in the conversation]}.'
)


@app.post("/assist/final")
async def assist_final(req: Request):
    """Generate the final candidate evaluation from the full interview history."""
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}
    data = await req.json()
    session = ASSIST_SESSIONS.get(data.get("sessionId", "")) or {}
    history = data.get("history") or []

    parts = []
    for i, h in enumerate(history, 1):
        cat = (h.get("category") or "?").strip() or "?"
        verdict = (h.get("verdict") or "—").strip()
        q = (h.get("question") or "").strip()
        ans = (h.get("answer") or "").strip()
        parts.append(f"Q{i} [{cat}] (live verdict: {verdict}): {q}\nA{i}: {ans}")
    interview_text = "\n\n".join(parts) or "(no questions asked)"

    user = (
        f"JOB DESCRIPTION:\n{session.get('jd') or '(none)'}\n\n"
        f"CANDIDATE RESUME:\n{session.get('resume') or '(none)'}\n\n"
        f"FULL INTERVIEW:\n{interview_text}"
    )
    result = await _gpt_json(FINAL_SYSTEM, user)
    score = result.get("score") or {}
    out = {
        "ok": True,
        "verdict": (result.get("verdict") or "").strip(),
        "summary": (result.get("summary") or "").strip(),
        "strengths": result.get("strengths") or [],
        "concerns": result.get("concerns") or [],
        "score": {
            "overall":       _safe_int(score.get("overall")),
            "communication": _safe_int(score.get("communication")),
            "relevance":     _safe_int(score.get("relevance")),
            "depth":         _safe_int(score.get("depth")),
            "skills_match":  _safe_int(score.get("skills_match")),
        },
    }

    # Persist to the saved interview row so the library reflects the final read.
    session_id = data.get("sessionId", "")
    if session_id:
        await asyncio.to_thread(
            db.save_analysis, session_id,
            out["score"], out["summary"], [],
            ASSIST_SESSIONS.get(session_id, {}).get("fields", _blank_fields()),
            {"verdict": out["verdict"], "rationale": out["summary"]},
            out["concerns"],
            out,  # full final evaluation -> final_json, so the library shows the same flashcard
        )
    return out


def _safe_int(v):
    try: return int(v)
    except (TypeError, ValueError): return None


@app.post("/assist/verify")
async def assist_verify(req: Request):
    """Evaluate a candidate's answer to a specific question; return verdict + follow-up."""
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}
    data = await req.json()
    question = (data.get("question") or "").strip()
    answer = (data.get("answer") or "").strip()
    if not question:
        return {"ok": False, "error": "A question is required."}
    if not answer:
        return {"ok": True, "satisfied": False, "verdict": "Vague",
                "feedback": "No answer captured yet.", "followUp": ""}

    session = ASSIST_SESSIONS.get(data.get("sessionId", "")) or {}
    user = (
        f"JOB DESCRIPTION:\n{session.get('jd') or '(none)'}\n\n"
        f"CANDIDATE RESUME:\n{session.get('resume') or '(none)'}\n\n"
        f"QUESTION ASKED:\n{question}\n\n"
        f"CANDIDATE'S ANSWER:\n{answer[:6000]}"
    )
    result = await _gpt_json(VERIFY_SYSTEM, user)
    return {
        "ok": True,
        "satisfied": bool(result.get("satisfied")),
        "verdict": result.get("verdict", ""),
        "feedback": result.get("feedback", ""),
        "followUp": result.get("followUp", ""),
    }


@app.post("/assist/start")
async def assist_start(
    jd_text: str = Form(""),
    resume_text: str = Form(""),
    interview_id: str = Form(""),
    jd_file: UploadFile | None = File(None),
    resume_file: UploadFile | None = File(None),
):
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}

    jd = jd_text.strip()
    resume = resume_text.strip()
    if jd_file is not None:
        jd = (extract_text(jd_file.filename, await jd_file.read()) + "\n" + jd).strip()
    if resume_file is not None:
        resume = (extract_text(resume_file.filename, await resume_file.read()) + "\n" + resume).strip()

    # Reuse a stored JD: if nothing was pasted/uploaded but the interview points at
    # a saved JD, pull that JD's text (the "one JD, many resumes" workflow).
    interview_id = (interview_id or "").strip()
    if not jd and interview_id:
        row = await asyncio.to_thread(db.get_interview, interview_id)
        if row and row.get("jd_id"):
            saved = await asyncio.to_thread(db.get_jd, row["jd_id"])
            if saved:
                jd = (saved.get("jd_text") or "").strip()

    # JD and resume are both optional now — the co-pilot still works off the live
    # transcript. Only generate the opening snapshot when we have something to read.
    summary, opening, fit_verdict, strengths, gaps = "", [], "", [], []
    if jd or resume:
        user = f"JOB DESCRIPTION:\n{jd or '(none provided)'}\n\nCANDIDATE RESUME:\n{resume or '(none provided)'}"
        result = await _gpt_json(START_SYSTEM, user)
        summary = result.get("summary", "")
        opening = result.get("openingQuestions", [])
        fit_verdict = result.get("fitVerdict", "")
        strengths = result.get("strengths", []) or []
        gaps = result.get("gaps", []) or []

    # Key the in-memory session by the interview id so the transcript, analyze loop,
    # and the saved row all share one id. Fall back to a fresh id if none was passed.
    # The per-session lock makes concurrent /assist/start + /assist/plan + /assist/next
    # calls for the SAME interview safe — different interviews are different keys and
    # never contend.
    session_id = interview_id or uuid.uuid4().hex
    async with _session_lock(session_id):
        existing = ASSIST_SESSIONS.get(session_id) or {}
        ASSIST_SESSIONS[session_id] = {
            "jd": jd or existing.get("jd", ""),
            "resume": resume or existing.get("resume", ""),
            "fields": existing.get("fields") or _blank_fields(),
        }
    if interview_id:
        await asyncio.to_thread(
            db.attach_assist, interview_id, jd, resume, summary, opening, fit_verdict, strengths, gaps
        )
    return {
        "ok": True,
        "sessionId": session_id,
        "summary": summary,
        "openingQuestions": opening,
        "fitVerdict": fit_verdict,
        "strengths": strengths,
        "gaps": gaps,
        "fields": _blank_fields(),
    }


@app.post("/assist/analyze")
async def assist_analyze(req: Request):
    if openai_client is None:
        return {"ok": False, "error": "OPENAI_API_KEY not set on the server."}

    data = await req.json()
    session = ASSIST_SESSIONS.get(data.get("sessionId", ""))
    if session is None:
        return {"ok": False, "error": "Unknown assist session — start the co-pilot first."}

    transcript = (data.get("transcript") or "").strip()
    if not transcript:
        return {"ok": True, "score": {}, "feedback": "", "suggestedQuestions": [],
                "recommendation": {}, "redFlags": [], "fields": session["fields"]}

    user = (
        f"JOB DESCRIPTION:\n{session['jd'] or '(none)'}\n\n"
        f"CANDIDATE RESUME:\n{session['resume'] or '(none)'}\n\n"
        f"LIVE TRANSCRIPT SO FAR:\n{transcript[:20000]}"
    )
    result = await _gpt_json(ANALYZE_SYSTEM, user)

    # Merge fields: a newly stated (non-blank) value wins; otherwise keep what we had.
    # Serialise the read-modify-write so two concurrent /assist/analyze ticks for the
    # SAME interview can't clobber each other's merge.
    session_id_for_lock = data.get("sessionId", "")
    new_fields = result.get("fields") or {}
    async with _session_lock(session_id_for_lock):
        for k in FIELD_KEYS:
            val = str(new_fields.get(k, "") or "").strip()
            if val:
                session["fields"][k] = val

    score = result.get("score", {})
    feedback = result.get("feedback", "")
    suggested = result.get("suggestedQuestions", [])
    recommendation = result.get("recommendation") or {}
    red_flags = result.get("redFlags", []) or []

    # Persist the latest analysis to the interview row so the library always holds
    # the most recent state (the sessionId is the interview id when one exists).
    session_id = data.get("sessionId", "")
    await asyncio.to_thread(
        db.save_analysis, session_id, score, feedback, suggested, session["fields"],
        recommendation, red_flags,
    )

    return {
        "ok": True,
        "score": score,
        "feedback": feedback,
        "suggestedQuestions": suggested,
        "recommendation": recommendation,
        "redFlags": red_flags,
        "fields": session["fields"],
    }


def _speaker_label(idx) -> str:
    """Map Deepgram's 0-based diarization speaker id to a display label."""
    try:
        return f"Speaker {int(idx) + 1}"
    except (TypeError, ValueError):
        return "Speaker 1"


def _diarized_runs(alt: dict) -> list[tuple[str, str]]:
    """Group an alternative's words into consecutive same-speaker runs.

    Returns a list of (speaker_label, text) tuples — one per speaker turn within
    the segment. Used in phone mode where a single mixed-mono stream carries both
    voices and Deepgram tags each word with a `speaker` id."""
    runs: list[tuple[str, list[str]]] = []
    for w in alt.get("words", []):
        label = _speaker_label(w.get("speaker", 0))
        token = w.get("punctuated_word") or w.get("word") or ""
        if not token:
            continue
        if runs and runs[-1][0] == label:
            runs[-1][1].append(token)
        else:
            runs.append((label, [token]))
    return [(label, " ".join(tokens).strip()) for label, tokens in runs if tokens]


@app.websocket("/stream")
async def stream(client: WebSocket):
    await client.accept()
    role = client.query_params.get("role", "unknown")
    phone_mode = role == "phone"
    speaker = {"interviewer": "Interviewer", "candidate": "Candidate"}.get(role, role)

    if not DEEPGRAM_API_KEY:
        await client.send_json({"type": "status", "state": "error",
                                "role": role, "message": "DEEPGRAM_API_KEY not set on server"})
        await client.close()
        return

    print(f"[client] connected: {speaker}")

    try:
        dg = await websockets.connect(
            deepgram_url(diarize=phone_mode),
            additional_headers={"Authorization": f"Token {DEEPGRAM_API_KEY}"},
            max_size=None,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[deepgram:{role}] connect failed: {exc}")
        await client.send_json({"type": "status", "state": "error",
                                "role": role, "message": str(exc)})
        await client.close()
        return

    await client.send_json({"type": "status", "state": "connected", "role": role})

    async def browser_to_deepgram():
        """Forward raw linear16 PCM frames from the browser to Deepgram."""
        try:
            while True:
                data = await client.receive_bytes()
                await dg.send(data)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001
            pass
        finally:
            # Signal end-of-stream so Deepgram flushes any final turn.
            try:
                await dg.send(json.dumps({"type": "CloseStream"}))
            except Exception:  # noqa: BLE001
                pass

    async def deepgram_to_browser():
        """Forward nova-3 `Results` messages to the browser, tagged with role."""
        try:
            async for message in dg:
                try:
                    msg = json.loads(message)
                except (ValueError, TypeError):
                    continue
                if msg.get("type") == "UtteranceEnd":
                    # Noise-independent turn boundary — close the current bubble by
                    # reusing the frontend's speechFinal path. In phone mode each
                    # final is already a discrete turn, so this just clears any
                    # dangling live-preview bubble.
                    await client.send_json({
                        "type": "transcript",
                        "role": role,
                        "mode": "phone" if phone_mode else "vc",
                        "speaker": speaker,
                        "transcript": "", "isFinal": False, "speechFinal": True,
                    })
                    continue
                if msg.get("type") != "Results":
                    continue  # ignore Metadata / SpeechStarted
                alts = msg.get("channel", {}).get("alternatives", [])
                alt = alts[0] if alts else {}
                transcript = alt.get("transcript", "")
                is_final = bool(msg.get("is_final"))
                # Skip empty interims; keep empty finals (they flush a turn end).
                if not transcript and not is_final:
                    continue

                if phone_mode:
                    # Split the mixed-mono stream into per-speaker turns via Deepgram's
                    # word-level diarization. Finals become discrete saved turns; interims
                    # show a single live-preview bubble under the trailing word's speaker.
                    if is_final:
                        runs = _diarized_runs(alt)
                        if not runs and transcript:
                            runs = [(speaker if speaker != "phone" else "Speaker 1", transcript)]
                        for run_speaker, run_text in runs:
                            await client.send_json({
                                "type": "transcript", "role": role, "mode": "phone",
                                "speaker": run_speaker, "transcript": run_text,
                                "isFinal": True, "speechFinal": True,
                            })
                    else:
                        words = alt.get("words", [])
                        live_speaker = _speaker_label(words[-1].get("speaker", 0)) if words else "Speaker 1"
                        await client.send_json({
                            "type": "transcript", "role": role, "mode": "phone",
                            "speaker": live_speaker, "transcript": transcript,
                            "isFinal": False, "speechFinal": False,
                        })
                    continue

                await client.send_json({
                    "type": "transcript",
                    "role": role,
                    "mode": "vc",
                    "speaker": speaker,
                    "transcript": transcript,
                    "isFinal": is_final,
                    "speechFinal": bool(msg.get("speech_final")),
                })
        except websockets.ConnectionClosed:
            pass
        except Exception:  # noqa: BLE001
            pass

    async def keep_alive():
        """Ping Deepgram during long silences so it doesn't time out the socket."""
        try:
            while True:
                await asyncio.sleep(7)
                await dg.send(json.dumps({"type": "KeepAlive"}))
        except Exception:  # noqa: BLE001
            pass

    sender = asyncio.create_task(browser_to_deepgram())
    receiver = asyncio.create_task(deepgram_to_browser())
    pinger = asyncio.create_task(keep_alive())

    # When either the browser or Deepgram side ends, tear everything down.
    _done, pending = await asyncio.wait(
        {sender, receiver}, return_when=asyncio.FIRST_COMPLETED
    )
    pending.add(pinger)
    for task in pending:
        task.cancel()
    await dg.close()
    print(f"[client] disconnected: {speaker}")


# Mount the static frontend last so it doesn't shadow /health or /stream.
if FRONTEND_DIR is not None:
    # Production: serve the built React app (Vite emits to frontend/dist).
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
else:
    @app.get("/")
    async def _missing_build():
        return {
            "ok": False,
            "message": (
                "Frontend build not found at frontend/dist. "
                "Run `cd frontend && npm install && npm run build` for production, "
                "or `npm run dev` to use the Vite dev server on http://localhost:5173."
            ),
        }


if __name__ == "__main__":
    import uvicorn

    if not DEEPGRAM_API_KEY:
        print("\n[warn] DEEPGRAM_API_KEY is not set. Create backend/.env (see README).\n")
    print(f"\n  Interview Assist  (model: {DEEPGRAM_MODEL})")
    print(f"  ▶ Open  http://localhost:{PORT}  in Chrome")
    print("    (use localhost — mic/screen capture is blocked on 0.0.0.0 / LAN IPs / file://)\n")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
