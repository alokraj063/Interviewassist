"""
Interview Assist — lightweight persistence (SQLite, stdlib only).

Stores the recruiter's Client → JD groups and saved interviews so a JD can be
created once and reused across many candidates, and past interviews (transcript +
co-pilot analysis) can be browsed later.

Transcript *text* is NOT duplicated here — it stays in the per-session
`transcripts/interview_<id>.jsonl` files written by server._append_turn. Each
interview row only references that file via `transcript_file`.

The connection is opened once with check_same_thread=False and guarded by a lock;
callers in the async app run these (blocking) functions via asyncio.to_thread.
"""

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data.db"

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    # Full uuid4: 32 hex chars, 122 bits of entropy — collisions are negligible even
    # under heavy concurrent insert load from many recruiters at once.
    return uuid.uuid4().hex


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, timeout=10.0)
    conn.row_factory = sqlite3.Row
    # WAL: concurrent readers don't block the single writer (or each other), which is
    # what we want for multi-recruiter usage. NORMAL sync is durable enough for the
    # post-call save pattern and keeps writes snappy.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def init_db() -> None:
    """Create tables if they don't exist. Safe to call on every startup."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = _connect()
        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS clients (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS jds (
                id          TEXT PRIMARY KEY,
                client_id   TEXT REFERENCES clients(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                jd_text     TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS interviews (
                id                  TEXT PRIMARY KEY,
                client_id           TEXT,
                jd_id               TEXT,
                candidate_name      TEXT NOT NULL DEFAULT '',
                resume_text         TEXT NOT NULL DEFAULT '',
                jd_text             TEXT NOT NULL DEFAULT '',
                call_mode           TEXT NOT NULL DEFAULT 'vc',
                transcript_file     TEXT NOT NULL DEFAULT '',
                summary             TEXT NOT NULL DEFAULT '',
                opening_questions   TEXT NOT NULL DEFAULT '[]',
                score_overall       INTEGER,
                score_comm          INTEGER,
                score_relevance     INTEGER,
                score_depth         INTEGER,
                feedback            TEXT NOT NULL DEFAULT '',
                suggested_questions TEXT NOT NULL DEFAULT '[]',
                fields_json         TEXT NOT NULL DEFAULT '{}',
                fit_verdict         TEXT NOT NULL DEFAULT '',
                strengths           TEXT NOT NULL DEFAULT '[]',
                gaps                TEXT NOT NULL DEFAULT '[]',
                rec_verdict         TEXT NOT NULL DEFAULT '',
                rec_rationale       TEXT NOT NULL DEFAULT '',
                red_flags           TEXT NOT NULL DEFAULT '[]',
                final_json          TEXT NOT NULL DEFAULT '{}',
                started_at          TEXT NOT NULL,
                ended_at            TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_jds_client ON jds(client_id);
            CREATE INDEX IF NOT EXISTS idx_interviews_client ON interviews(client_id);
            CREATE INDEX IF NOT EXISTS idx_interviews_jd ON interviews(jd_id);
            """
        )
        # Lightweight migration for DBs created before the assessment columns existed.
        _migrations = [
            ("fit_verdict", "TEXT NOT NULL DEFAULT ''"),
            ("strengths", "TEXT NOT NULL DEFAULT '[]'"),
            ("gaps", "TEXT NOT NULL DEFAULT '[]'"),
            ("rec_verdict", "TEXT NOT NULL DEFAULT ''"),
            ("rec_rationale", "TEXT NOT NULL DEFAULT ''"),
            ("red_flags", "TEXT NOT NULL DEFAULT '[]'"),
            ("final_json", "TEXT NOT NULL DEFAULT '{}'"),
        ]
        for col, decl in _migrations:
            try:
                _conn.execute(f"ALTER TABLE interviews ADD COLUMN {col} {decl}")
            except sqlite3.OperationalError:
                pass  # column already exists
        _conn.commit()


def _db() -> sqlite3.Connection:
    if _conn is None:
        init_db()
    assert _conn is not None
    return _conn


# ---------------------------------------------------------------------------
# Clients
# ---------------------------------------------------------------------------
def create_client(name: str) -> dict:
    cid = _new_id()
    row = {"id": cid, "name": name.strip(), "created_at": _now()}
    with _lock:
        _db().execute(
            "INSERT INTO clients (id, name, created_at) VALUES (:id, :name, :created_at)", row
        )
        _db().commit()
    return row


def list_clients() -> list[dict]:
    with _lock:
        rows = _db().execute(
            """
            SELECT c.id, c.name, c.created_at,
                   (SELECT COUNT(*) FROM jds j WHERE j.client_id = c.id) AS jd_count
            FROM clients c
            ORDER BY c.name COLLATE NOCASE
            """
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# JDs
# ---------------------------------------------------------------------------
def create_jd(client_id: str | None, title: str, jd_text: str) -> dict:
    jid = _new_id()
    row = {
        "id": jid,
        "client_id": client_id or None,
        "title": title.strip() or "Untitled role",
        "jd_text": jd_text or "",
        "created_at": _now(),
    }
    with _lock:
        _db().execute(
            "INSERT INTO jds (id, client_id, title, jd_text, created_at) "
            "VALUES (:id, :client_id, :title, :jd_text, :created_at)",
            row,
        )
        _db().commit()
    return row


def list_jds(client_id: str | None = None) -> list[dict]:
    with _lock:
        if client_id:
            rows = _db().execute(
                "SELECT id, client_id, title, jd_text, created_at FROM jds "
                "WHERE client_id = ? ORDER BY title COLLATE NOCASE",
                (client_id,),
            ).fetchall()
        else:
            rows = _db().execute(
                "SELECT id, client_id, title, jd_text, created_at FROM jds "
                "ORDER BY title COLLATE NOCASE"
            ).fetchall()
    return [dict(r) for r in rows]


def get_jd(jd_id: str) -> dict | None:
    with _lock:
        row = _db().execute(
            "SELECT id, client_id, title, jd_text, created_at FROM jds WHERE id = ?", (jd_id,)
        ).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Interviews
# ---------------------------------------------------------------------------
def create_interview(
    client_id: str | None,
    jd_id: str | None,
    candidate_name: str,
    call_mode: str,
) -> dict:
    iid = _new_id()
    row = {
        "id": iid,
        "client_id": client_id or None,
        "jd_id": jd_id or None,
        "candidate_name": (candidate_name or "").strip(),
        "call_mode": call_mode or "vc",
        "transcript_file": f"interview_{iid}.jsonl",
        "started_at": _now(),
    }
    with _lock:
        _db().execute(
            "INSERT INTO interviews "
            "(id, client_id, jd_id, candidate_name, call_mode, transcript_file, started_at) "
            "VALUES (:id, :client_id, :jd_id, :candidate_name, :call_mode, :transcript_file, :started_at)",
            row,
        )
        _db().commit()
    return row


def attach_assist(
    interview_id: str,
    jd_text: str,
    resume_text: str,
    summary: str,
    opening_questions: list[str],
    fit_verdict: str = "",
    strengths: list[str] | None = None,
    gaps: list[str] | None = None,
) -> None:
    with _lock:
        _db().execute(
            "UPDATE interviews SET jd_text = ?, resume_text = ?, summary = ?, "
            "opening_questions = ?, fit_verdict = ?, strengths = ?, gaps = ? WHERE id = ?",
            (
                jd_text or "", resume_text or "", summary or "",
                json.dumps(opening_questions or []), fit_verdict or "",
                json.dumps(strengths or []), json.dumps(gaps or []), interview_id,
            ),
        )
        _db().commit()


def save_analysis(
    interview_id: str,
    score: dict,
    feedback: str,
    suggested_questions: list[str],
    fields: dict,
    recommendation: dict | None = None,
    red_flags: list[str] | None = None,
    final: dict | None = None,
) -> None:
    score = score or {}
    recommendation = recommendation or {}

    def _i(v):
        try:
            return int(v)
        except (TypeError, ValueError):
            return None

    with _lock:
        _db().execute(
            "UPDATE interviews SET score_overall = ?, score_comm = ?, score_relevance = ?, "
            "score_depth = ?, feedback = ?, suggested_questions = ?, fields_json = ?, "
            "rec_verdict = ?, rec_rationale = ?, red_flags = ?, final_json = ? WHERE id = ?",
            (
                _i(score.get("overall")),
                _i(score.get("communication")),
                _i(score.get("relevance")),
                _i(score.get("depth")),
                feedback or "",
                json.dumps(suggested_questions or []),
                json.dumps(fields or {}),
                str(recommendation.get("verdict") or ""),
                str(recommendation.get("rationale") or ""),
                json.dumps(red_flags or []),
                json.dumps(final or {}),
                interview_id,
            ),
        )
        _db().commit()


def end_interview(interview_id: str) -> None:
    with _lock:
        _db().execute("UPDATE interviews SET ended_at = ? WHERE id = ?", (_now(), interview_id))
        _db().commit()


def list_interviews(client_id: str | None = None, jd_id: str | None = None) -> list[dict]:
    where, params = [], []
    if client_id:
        where.append("i.client_id = ?")
        params.append(client_id)
    if jd_id:
        where.append("i.jd_id = ?")
        params.append(jd_id)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    with _lock:
        rows = _db().execute(
            f"""
            SELECT i.id, i.client_id, i.jd_id, i.candidate_name, i.call_mode,
                   i.score_overall, i.rec_verdict, i.started_at, i.ended_at,
                   c.name AS client_name, j.title AS jd_title
            FROM interviews i
            LEFT JOIN clients c ON c.id = i.client_id
            LEFT JOIN jds j ON j.id = i.jd_id
            {clause}
            ORDER BY i.started_at DESC
            """,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def _read_turns(transcript_file: str) -> list[dict]:
    """Read finalized turns from the per-session .jsonl (one JSON object per line)."""
    if not transcript_file:
        return []
    path = (Path(__file__).resolve().parent.parent / "transcripts" / transcript_file)
    if not path.exists():
        return []
    turns = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            turns.append(json.loads(line))
        except ValueError:
            continue
    return turns


def get_interview(interview_id: str) -> dict | None:
    with _lock:
        row = _db().execute(
            """
            SELECT i.*, c.name AS client_name, j.title AS jd_title
            FROM interviews i
            LEFT JOIN clients c ON c.id = i.client_id
            LEFT JOIN jds j ON j.id = i.jd_id
            WHERE i.id = ?
            """,
            (interview_id,),
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    d["opening_questions"] = json.loads(d.get("opening_questions") or "[]")
    d["suggested_questions"] = json.loads(d.get("suggested_questions") or "[]")
    d["fields"] = json.loads(d.get("fields_json") or "{}")
    d["strengths"] = json.loads(d.get("strengths") or "[]")
    d["gaps"] = json.loads(d.get("gaps") or "[]")
    d["red_flags"] = json.loads(d.get("red_flags") or "[]")
    d["recommendation"] = {
        "verdict": d.get("rec_verdict") or "",
        "rationale": d.get("rec_rationale") or "",
    }
    d["score"] = {
        "overall": d.get("score_overall"),
        "communication": d.get("score_comm"),
        "relevance": d.get("score_relevance"),
        "depth": d.get("score_depth"),
    }
    # Full end-of-call evaluation (same shape /assist/final returns) so the library can
    # render the identical final flashcard the recruiter saw live.
    d["final"] = json.loads(d.get("final_json") or "{}")
    d["turns"] = _read_turns(d.get("transcript_file", ""))
    return d
