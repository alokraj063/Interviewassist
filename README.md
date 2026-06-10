# Interview Assist — Live Call Transcription

For a recruiter taking interview calls in the browser — **Microsoft Teams, Zoom,
Google Meet, or FreJun** — this listens to the call and transcribes it **live**,
labelling each speaker:

- **Interviewer** = the recruiter who starts the session (your **microphone**)
- **Candidate** = the other side of the call (the **call/tab audio**)

Built on [Deepgram **nova-3** streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming).
Two independent audio sources → two nova-3 streams → exact, reliable speaker labels
(no diarization guesswork).

```
┌──────────── browser (frontend) ────────────┐        ┌──── backend (FastAPI) ────┐        ┌─── Deepgram ───┐
│  mic  ─► AudioWorklet ─► 16k PCM ─► WS ──────┼───────►│  /stream?role=interviewer ┼───────►│  nova-3 (v1)   │
│  tab  ─► AudioWorklet ─► 16k PCM ─► WS ──────┼───────►│  /stream?role=candidate   ┼───────►│  nova-3 (v1)   │
│            live transcript  ◄────── JSON ◄───┼────────┤  relays Results messages  ◄┼────────┤                │
└─────────────────────────────────────────────┘        └───────────────────────────┘        └────────────────┘
```

The Deepgram API key lives **only** on the backend — the browser never sees it.

---

## Project layout

```
backend/      FastAPI WebSocket proxy + static host  (Python)
  server.py
  pyproject.toml
frontend/     Static UI (no build step)
  index.html
  styles.css
  app.js
  pcm-worklet.js   AudioWorklet: resample to 16 kHz linear16
```

---

## Setup

### 1. Add your Deepgram key

Create `backend/.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
OPENAI_API_KEY=your_openai_api_key_here     # for the interview co-pilot

# optional
PORT=3001
DEEPGRAM_MODEL=nova-3            # real-time STT model
DEEPGRAM_LANGUAGE=en            # or "multi" for multilingual
DEEPGRAM_ENDPOINTING=300        # ms of silence that ends an utterance
OPENAI_MODEL=gpt-4o-mini        # co-pilot model
```

Get a Deepgram key at <https://console.deepgram.com/> and an OpenAI key at
<https://platform.openai.com/api-keys>. Both keys stay on the backend — never sent to the browser.

### 2. Install & run (uses [uv](https://docs.astral.sh/uv/))

```bash
cd backend
uv run server.py
```

`uv` creates the virtualenv and installs dependencies automatically on first run.

> Plain pip alternative:
> ```bash
> cd backend && python3 -m venv .venv && source .venv/bin/activate
> pip install -e . && python server.py
> ```

### 3. Open the app

<http://localhost:3001>

The backend serves the frontend, so everything is one origin (no CORS/WS issues).

> **Use `localhost` specifically.** Mic and screen capture only work in a secure context.
> Opening the app on `http://0.0.0.0:3001`, a LAN IP (`http://192.168.x.x:3001`), or a
> `file://` path makes `navigator.mediaDevices` unavailable and Start will fail with a
> clear "secure origin" message. `http://localhost:3001` / `http://127.0.0.1:3001` work.

---

## How to use

Pick a **Call type** with the toggle next to the controls:

### VC tab (default) — Teams / Zoom / Meet in a browser tab

1. Click **Start listening** → allow the **microphone** (this is the Interviewer).
2. In the screen-share dialog, pick the **Teams / Zoom / Meet / FreJun tab** and tick
   **“Share tab audio”** (Chrome) / **“Share system audio”**. That side is the Candidate.
3. Talk — labelled transcripts stream in live. Use **Copy** to grab the transcript.

Two independent Deepgram streams → **exact** speaker labels (`Interviewer` /
`Candidate`). If the mic is blocked you can still run Candidate-only (and
vice-versa); the banner tells you what's live.

### Phone — candidate on a regular phone call (speakerphone)

For real phone calls where there's no tab to share: put the candidate on
**speakerphone** near your laptop, switch the toggle to **Phone**, and click
**Start listening** → allow the **microphone**.

- Only your laptop mic is captured (no tab share). Both voices arrive as one
  **mixed-mono** stream, so echo cancellation is turned **off** (otherwise the
  candidate's voice coming out of the phone speaker would be suppressed).
- A **single** Deepgram stream with **live diarization** splits the audio into
  **Speaker 1 / Speaker 2** turns in real time. Labels are **best-effort** on a
  mixed source — they are not guaranteed to map to recruiter-vs-candidate.
- For Hinglish / multilingual phone calls, set `DEEPGRAM_LANGUAGE=multi` in
  `backend/.env`.

The co-pilot (below) works identically in both modes.

Each session's transcript is **saved live** to `transcripts/interview_<id>.txt` (readable
`[HH:MM:SS] Speaker: text` lines) and `transcripts/interview_<id>.jsonl` (structured, one
turn per line) — every turn is appended the moment it's finalized.

---

## Interview co-pilot (GPT-4o-mini)

The right-hand **Interview Assist** panel turns the live transcript into recruiter guidance:

1. **Set up the call.** Pick (or create) a **Client** and a **JD**, optionally add a
   **candidate name** and **resume**, then click **Start assist** → you get a candidate
   **snapshot** and **2–3 opening questions**.
   - **The JD is stored once per role and reused across candidates** — for the next
     candidate, just change the resume and start again. JDs live under their Client.
   - **JD and resume are both optional.** With neither, Start assist still works and the
     co-pilot guides purely from the **live transcript**.
   - No Client/JD selected? That's fine — the interview is saved under **Unassigned**.
2. As the call runs, the panel **auto-refreshes every ~30 seconds** (only when there's new
   transcript), showing:
   - **How it's going** — an overall score plus communication / relevance / depth bars and a
     one-line, actionable **feedback** note.
   - **Suggested next questions** — click any question to copy it.
   - **Candidate details** — Current Position, Company, Location, Current Salary, Expected
     Salary, filled in **only when the candidate states them**, otherwise left blank.
3. Hit **↻ Refresh** any time to update immediately.

The OpenAI key lives only on the backend (`/assist/start`, `/assist/analyze`); the browser
sends JD/resume once and the running transcript text per refresh.

## Saved interviews (Library)

Clients, JDs, and interviews are persisted in a local **SQLite** file
(`backend/data.db`, created automatically — no setup, no extra dependencies). The
transcript *text* stays in the `transcripts/*.jsonl` files; the database just references them.

Switch to the **Library** tab (top bar) to browse past interviews grouped by **Client → JD**
(ad-hoc ones under **Unassigned**). Click any interview to see its saved transcript plus the
last co-pilot analysis — score, feedback, suggested questions, and extracted candidate fields.

> Interviews recorded before this feature existed (old timestamp-named transcript files)
> won't appear in the Library — only interviews started from the reworked setup panel are
> tracked in the database.

### macOS: microphone shows "blocked" with no prompt

If clicking Start denies the mic **without any popup**, macOS is blocking it at the OS
level. Fix it once:

1. **System Settings → Privacy & Security → Microphone → enable Google Chrome**.
2. **Fully quit Chrome** (⌘Q) and reopen it — the permission only takes effect on restart.
3. Also check the address-bar camera/site icon isn't set to **Block** for `localhost`.

---

## Important: what "detect the call" really means

A normal web page **cannot silently tap into Teams / Zoom / FreJun audio** — browsers
sandbox that for privacy. There is no API to auto-detect a running call. So we use
the standard, permission-based capture the browser *does* allow:

| Speaker      | Source                                   | Browser API        |
|--------------|------------------------------------------|--------------------|
| Interviewer  | your microphone                          | `getUserMedia`     |
| Candidate    | the call's audio (a shared tab/screen)   | `getDisplayMedia`  |

- **Best capture:** run the call **in a browser tab** and share *that tab* with audio.
- **Desktop Teams/Zoom apps:** share the **whole screen** with system audio
  (works in Chrome/Edge on Windows; on macOS, system-audio sharing is limited —
  the in-browser call is the most reliable path).
- For a true "auto-detect + always-on" experience you'd need a **browser extension**
  or a desktop helper; that can be added later on top of this same backend.

---

## Tech notes

- Audio is resampled to **16 kHz mono linear16** in an `AudioWorklet` and sent in
  ~80 ms frames.
- Streaming endpoint: `wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&…`
- Rendering: each `Results` message carries `is_final` / `speech_final`. Interim text
  updates the live bubble; `is_final` segments are accumulated; `speech_final` finalizes
  the turn. The backend normalises this to `{ transcript, isFinal, speechFinal }` so the
  frontend stays decoupled from Deepgram's raw schema.
- The backend sends a periodic `KeepAlive` so the socket survives long silences.
- Requires Chrome/Edge (AudioWorklet + `getDisplayMedia` audio). `localhost` is a
  secure context, so mic/share permissions work without HTTPS.

> **Want Flux instead?** Switch the endpoint to `wss://api.deepgram.com/v2/listen`,
> set the model to `flux-general-en`, and parse `TurnInfo` / `EndOfTurn` events. Flux is
> turn-based and lower-latency for conversational agents; nova-3 is general real-time STT.
