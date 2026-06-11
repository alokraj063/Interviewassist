// Interview Assist — one button, one question at a time, generated as you go.
//
// Workflow:
//   1. Recruiter picks Client + JD, uploads the candidate's resume, picks call mode,
//      clicks ▶ Start interview.
//   2. We capture audio (window.startListening() — defined in app.js) AND ask the
//      backend for the FIRST question via /assist/next (with empty history).
//   3. The single "Ask next" card shows that question. The candidate answers; their
//      turns stream into window.getTranscript(). Every TICK_MS we re-evaluate the
//      growing answer via /assist/verify.
//   4. When the answer is satisfactory we push the {question, answer, verdict} into
//      history and call /assist/next AGAIN — the backend uses the resume + JD + the
//      full history to choose the next question. Weak answers stay on the current
//      question and surface a follow-up the recruiter can ask.
//   5. Repeat until /assist/next returns {done: true}, or the recruiter clicks Stop.
//
// The OpenAI / Deepgram keys, JD bodies, and resume contents stay on the backend.

// Watch the transcript every WATCH_MS and tick when something changes; fall back
// to a slow background tick so we never get fully stuck.
const WATCH_MS = 400;        // how often we poll the transcript for new turns
const SILENCE_MS = 1800;     // candidate-stops-talking debounce before we verify
const SAFETY_TICK_MS = 8000; // background fallback if nothing else fires
const MIN_ANSWER_CHARS = 20; // don't burn tokens on 1-word noises
const ADVANCE_LOCK_MS = 1200;// guard against rapid-fire question flipping
const NEW = '__new__';

const a = {
  start: document.getElementById('assistStart'),
  refresh: document.getElementById('assistRefresh'),
  status: document.getElementById('assistStatus'),
  setup: document.getElementById('assistSetup'),

  clientSelect: document.getElementById('clientSelect'),
  jdSelect: document.getElementById('jdSelect'),
  newClientBtn: document.getElementById('newClientBtn'),
  newClientRow: document.getElementById('newClientRow'),
  newClientName: document.getElementById('newClientName'),
  saveClientBtn: document.getElementById('saveClientBtn'),
  newJdBtn: document.getElementById('newJdBtn'),
  newJdRow: document.getElementById('newJdRow'),
  newJdTitle: document.getElementById('newJdTitle'),
  newJdText: document.getElementById('newJdText'),
  newJdFile: document.getElementById('newJdFile'),
  saveJdBtn: document.getElementById('saveJdBtn'),
  resumeFile: document.getElementById('resumeFile'),

  // Ask-next card
  askCard: document.getElementById('askNextCard'),
  askCat: document.getElementById('askNextCat'),
  askQ: document.getElementById('askNextQuestion'),
  askProgress: document.getElementById('askNextProgress'),
  askSkip: document.getElementById('askNextSkip'),
  askDone: document.getElementById('askNextDone'),
  askFinish: document.getElementById('askNextFinish'),

  // Final score card
  finalCard: document.getElementById('finalCard'),
  finalVerdict: document.getElementById('finalVerdict'),
  finalRing: document.getElementById('finalRing'),
  finalOverall: document.getElementById('finalOverall'),
  finalBarSkills: document.getElementById('finalBarSkills'),
  finalBarRel: document.getElementById('finalBarRel'),
  finalBarDepth: document.getElementById('finalBarDepth'),
  finalBarComm: document.getElementById('finalBarComm'),
  finalSummary: document.getElementById('finalSummary'),
  finalStrengths: document.getElementById('finalStrengths'),
  finalConcerns: document.getElementById('finalConcerns'),

  // Latest answer card
  lastCard: document.getElementById('lastAnswerCard'),
  lastVerdict: document.getElementById('lastAnsVerdict'),
  lastFb: document.getElementById('lastAnsFeedback'),
  lastQuote: document.getElementById('lastAnsQuote'),
  lastFollowup: document.getElementById('lastAnsFollowup'),

  // History card
  queueCard: document.getElementById('planQueueCard'),
  queue: document.getElementById('planQueue'),

  // Snapshot + recommendation (lightweight, kept from before)
  snapshotCard: document.getElementById('assistSnapshotCard'),
  snapshot: document.getElementById('assistSnapshot'),
  fitVerdict: document.getElementById('assistFitVerdict'),
  strengths: document.getElementById('assistStrengths'),
  gaps: document.getElementById('assistGaps'),
  recCard: document.getElementById('assistRecCard'),
  recVerdict: document.getElementById('assistRecVerdict'),
  recRationale: document.getElementById('assistRecRationale'),
};

// Live session state
const S = {
  sessionId: null,
  history: [],         // [{category, question, answer, verdict, feedback}]
  current: null,       // {category, question}
  currentStartLen: 0,  // window.getTranscript().length when the question went active
  lastTickedLen: 0,
  lastSeenLen: 0,      // last transcript length our watcher saw
  ticking: false,
  fetchingNext: false,
  safetyTimer: null,
  watcherTimer: null,
  silenceTimer: null,
  advanceLockUntil: 0, // ms timestamp — no further auto-advance before this
  running: false,
};

function setStatus(text, kind = '') {
  a.status.textContent = text || '';
  a.status.dataset.kind = kind;
}
function show(el) { el && el.classList.remove('hidden'); }
function hide(el) { el && el.classList.add('hidden'); }
function realValue(sel) { const v = sel.value; return v && v !== NEW ? v : ''; }

// ---------------------------------------------------------------------------
// Client / JD pickers
// ---------------------------------------------------------------------------
async function loadClients(selectId) {
  let clients = [];
  try {
    const res = await fetch('/api/clients');
    const data = await res.json();
    if (data.ok) clients = data.clients;
  } catch {}
  a.clientSelect.innerHTML = '';
  a.clientSelect.appendChild(new Option('(No client)', ''));
  clients.forEach((c) => a.clientSelect.appendChild(new Option(c.name, c.id)));
  a.clientSelect.appendChild(new Option('＋ New client…', NEW));
  if (selectId) a.clientSelect.value = selectId;
  await loadJds();
}

async function loadJds(selectId) {
  const clientId = realValue(a.clientSelect);
  let jds = [];
  if (clientId) {
    try {
      const res = await fetch(`/api/jds?client_id=${encodeURIComponent(clientId)}`);
      const data = await res.json();
      if (data.ok) jds = data.jds;
    } catch {}
  }
  a.jdSelect.innerHTML = '';
  a.jdSelect.appendChild(new Option('(No JD)', ''));
  jds.forEach((j) => a.jdSelect.appendChild(new Option(j.title, j.id)));
  a.jdSelect.appendChild(new Option('＋ New JD…', NEW));
  if (selectId) a.jdSelect.value = selectId;
}

function onClientChange() {
  if (a.clientSelect.value === NEW) {
    a.clientSelect.value = '';
    show(a.newClientRow); a.newClientName.focus();
  } else hide(a.newClientRow);
  loadJds();
}

async function saveClient() {
  const name = (a.newClientName.value || '').trim();
  if (!name) { a.newClientName.focus(); return; }
  try {
    const res = await fetch('/api/clients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.ok) {
      a.newClientName.value = ''; hide(a.newClientRow);
      await loadClients(data.client.id);
    } else setStatus(data.error || 'Could not create client.', 'error');
  } catch { setStatus('Network error creating client.', 'error'); }
}

function onJdChange() {
  if (a.jdSelect.value === NEW) {
    a.jdSelect.value = '';
    show(a.newJdRow); a.newJdTitle.focus();
  } else hide(a.newJdRow);
}

function onJdFileChange() {
  const f = a.newJdFile.files[0];
  if (f && !a.newJdTitle.value.trim()) {
    a.newJdTitle.value = f.name.replace(/\.[^.]+$/, '');
  }
}

async function saveJd() {
  const title = (a.newJdTitle.value || '').trim();
  if (!title) { a.newJdTitle.focus(); return; }
  try {
    const fd = new FormData();
    fd.append('client_id', realValue(a.clientSelect) || '');
    fd.append('title', title);
    fd.append('jd_text', a.newJdText.value || '');
    if (a.newJdFile.files[0]) fd.append('jd_file', a.newJdFile.files[0]);
    const res = await fetch('/api/jds', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.ok) {
      a.newJdTitle.value = ''; a.newJdText.value = ''; a.newJdFile.value = '';
      hide(a.newJdRow);
      await loadJds(data.jd.id);
    } else setStatus(data.error || 'Could not create JD.', 'error');
  } catch { setStatus('Network error creating JD.', 'error'); }
}

// ---------------------------------------------------------------------------
// Interview lifecycle — shared with app.js so audio + saved row + assist agree
// ---------------------------------------------------------------------------
window.interview = null;

window.ensureInterview = async function () {
  if (window.interview) return window.interview.id;
  const clientId = realValue(a.clientSelect);
  const jdId = realValue(a.jdSelect);
  const modeEl = document.querySelector('input[name="callMode"]:checked');
  const call_mode = (modeEl && modeEl.value) || 'vc';

  if (window.resetTranscript) window.resetTranscript();
  resetCards();

  try {
    const res = await fetch('/api/interviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId || null, jd_id: jdId || null,
                             candidate_name: '', call_mode }),
    });
    const data = await res.json();
    if (data.ok && data.interview) {
      window.interview = { id: data.interview.id, clientId, jdId };
      return window.interview.id;
    }
  } catch {}
  window.interview = { id: (window.makeSessionId ? window.makeSessionId() : Date.now().toString()),
                       clientId, jdId, local: true };
  return window.interview.id;
};

window.endInterview = async function () {
  const it = window.interview;
  window.interview = null;
  S.sessionId = null;
  S.running = false;
  clearInterval(S.safetyTimer);
  clearInterval(S.watcherTimer);
  clearTimeout(S.silenceTimer);
  a.refresh.disabled = true;
  a.start.disabled = false;
  show(a.setup);
  if (it && !it.local) {
    try { await fetch(`/api/interviews/${it.id}/end`, { method: 'POST' }); } catch {}
  }
};

function resetCards() {
  [a.askCard, a.lastCard, a.queueCard, a.snapshotCard, a.recCard, a.finalCard].forEach(hide);
  a.askQ.textContent = '—';
  a.askCat.textContent = '—';
  a.askProgress.textContent = '— of —';
  a.lastVerdict.textContent = 'Waiting…';
  a.lastVerdict.dataset.kind = 'wait';
  a.lastFb.textContent = '';
  a.lastQuote.textContent = ''; hide(a.lastQuote);
  a.lastFollowup.textContent = ''; hide(a.lastFollowup);
  a.queue.innerHTML = '';
  S.history = [];
  S.current = null;
  S.currentStartLen = 0;
  S.lastTickedLen = 0;
}

// ---------------------------------------------------------------------------
// Single Start button — owns: audio capture + plan setup + first question
// ---------------------------------------------------------------------------
async function startInterview() {
  if (!a.resumeFile.files[0]) {
    setStatus('Upload the candidate resume (PDF / DOCX / TXT) before starting.', 'error');
    a.resumeFile.focus();
    return;
  }
  if (!window.startListening) {
    setStatus('Audio capture is not available — refresh the page.', 'error');
    return;
  }

  a.start.disabled = true;
  setStatus('Starting audio capture…');

  // 1) Audio capture first — getUserMedia / getDisplayMedia must run in the click handler
  //    chain to satisfy browser permission policies. ensureInterview() is called inside
  //    startListening, so the interview row exists by the time it resolves.
  try {
    await window.startListening();
  } catch (err) {
    setStatus('Could not start audio capture. ' + (err && err.message ? err.message : ''), 'error');
    a.start.disabled = false;
    return;
  }

  const id = window.interview && window.interview.id;
  if (!id) {
    setStatus('Lost the interview id — please try again.', 'error');
    a.start.disabled = false;
    return;
  }

  // 2) Load the resume + JD on the backend, in parallel with the audio coming up.
  setStatus('Reading the resume and the JD…');
  const file = a.resumeFile.files[0];

  // /assist/start gives us the pre-call fit snapshot (also stashes JD+resume in the
  // session so /assist/next has full context).
  const startRes = await sendStart(id, file);
  if (!startRes || !startRes.ok) {
    setStatus(startRes?.error || 'Could not load the resume into the assist session.', 'error');
    a.start.disabled = false;
    return;
  }
  S.sessionId = startRes.sessionId;
  renderSnapshot(startRes);

  // 3) Ask the backend for the FIRST question.
  hide(a.setup);
  show(a.askCard); show(a.lastCard); show(a.queueCard);
  a.refresh.disabled = false;
  S.running = true;
  await fetchNextQuestion(/*initial*/ true);

  // 4) Watch the live transcript reactively, with a slow safety net behind it.
  clearInterval(S.watcherTimer);
  clearInterval(S.safetyTimer);
  S.lastSeenLen = ((window.getTranscript && window.getTranscript()) || []).length;
  S.watcherTimer = setInterval(watchTranscript, WATCH_MS);
  S.safetyTimer = setInterval(() => tick(), SAFETY_TICK_MS);
}

async function sendStart(interviewId, file) {
  const fd = new FormData();
  fd.append('interview_id', interviewId);
  fd.append('resume_file', file);
  try {
    const res = await fetch('/assist/start', { method: 'POST', body: fd });
    return await res.json();
  } catch { return null; }
}

function renderSnapshot(data) {
  if (data.summary || data.fitVerdict) {
    a.snapshot.textContent = data.summary || '';
    if (data.fitVerdict) {
      a.fitVerdict.textContent = data.fitVerdict;
      a.fitVerdict.style.background = IAUI.verdictColor(data.fitVerdict);
      a.fitVerdict.hidden = false;
    }
    renderEvidence(a.strengths, data.strengths, '✓');
    renderEvidence(a.gaps, data.gaps, '✗');
    show(a.snapshotCard);
  }
}

function renderEvidence(ul, items, marker) {
  ul.innerHTML = '';
  (items || []).forEach((t) => {
    const li = document.createElement('li');
    li.textContent = `${marker} ${t}`;
    ul.appendChild(li);
  });
  ul.hidden = !(items || []).length;
}

// ---------------------------------------------------------------------------
// /assist/next — fetch ONE question, given resume+JD+history
// ---------------------------------------------------------------------------
async function fetchNextQuestion(initial = false) {
  if (!S.sessionId || S.fetchingNext) return;
  S.fetchingNext = true;
  setStatus(initial ? 'Designing the first question…' : 'Choosing the next question…');
  try {
    const res = await fetch('/assist/next', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId, history: S.history }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus(data.error || 'Could not get the next question.', 'error'); return; }

    if (data.done || !data.question) {
      await finishInterview('You have enough signal — generating the final score…');
      return;
    }
    S.current = { category: data.category || '—', question: data.question };
    showCurrentQuestion();
    setStatus('Live — ask the question. I’ll auto-advance once they answer.', 'ok');
  } catch {
    setStatus('Network error fetching the next question.', 'error');
  } finally {
    S.fetchingNext = false;
  }
}

function showCurrentQuestion() {
  if (!S.current) return;
  a.askCat.textContent = S.current.category || '—';
  a.askQ.textContent = S.current.question;
  a.askProgress.textContent = `Q${S.history.length + 1}`;
  S.currentStartLen = ((window.getTranscript && window.getTranscript()) || []).length;
  S.lastTickedLen = S.currentStartLen;
  a.lastVerdict.textContent = 'Waiting…';
  a.lastVerdict.dataset.kind = 'wait';
  a.lastFb.textContent = 'Listening for the candidate\'s answer.';
  a.lastQuote.textContent = ''; hide(a.lastQuote);
  a.lastFollowup.textContent = ''; hide(a.lastFollowup);
}

async function finishInterview(message) {
  S.current = null;
  S.running = false;
  clearInterval(S.safetyTimer);
  clearInterval(S.watcherTimer);
  clearTimeout(S.silenceTimer);
  a.askQ.textContent = 'Interview wrapped — see the final evaluation below.';
  a.askCat.textContent = 'Wrap-up';
  a.askProgress.textContent = `${S.history.length} asked`;
  setStatus(message || 'Generating the final score…');
  await fetchFinalScore();
}

// ---------------------------------------------------------------------------
// Final score: one /assist/final call, then render verdict + dimensions + summary
// ---------------------------------------------------------------------------
async function fetchFinalScore() {
  if (!S.sessionId) return;
  if (!S.history.length) {
    setStatus('No questions asked yet — ask a few before ending.', 'error');
    return;
  }
  try {
    const res = await fetch('/assist/final', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId, history: S.history }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus(data.error || 'Final scoring failed.', 'error'); return; }
    renderFinalScore(data);
    setStatus('Done — final score ready below.', 'ok');
  } catch {
    setStatus('Network error generating the final score.', 'error');
  }
}

function renderFinalScore(data) {
  const score = data.score || {};
  const overall = (typeof score.overall === 'number') ? score.overall : 0;

  a.finalOverall.textContent = (typeof score.overall === 'number') ? score.overall : '–';
  a.finalRing.style.setProperty('--val', overall);
  a.finalRing.style.setProperty('--c', IAUI.scoreColor(overall));

  a.finalBarSkills.style.width = `${score.skills_match || 0}%`;
  a.finalBarRel.style.width    = `${score.relevance    || 0}%`;
  a.finalBarDepth.style.width  = `${score.depth        || 0}%`;
  a.finalBarComm.style.width   = `${score.communication|| 0}%`;

  const verdict = (data.verdict || '').trim() || '—';
  a.finalVerdict.textContent = verdict;
  a.finalVerdict.style.background = IAUI.verdictColor(verdict);

  a.finalSummary.textContent = data.summary || '';
  renderEvidence(a.finalStrengths, data.strengths, '✓');
  renderEvidence(a.finalConcerns,  data.concerns,  '✗');
  show(a.finalCard);
  a.finalCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function endInterviewManual() {
  if (!S.running && !S.history.length) return;
  await finishInterview('Wrapping up early — generating the final score…');
}

// ---------------------------------------------------------------------------
// Capture the candidate's answer from the live transcript
// ---------------------------------------------------------------------------
function capturedAnswer() {
  if (!S.current) return '';
  const log = (window.getTranscript && window.getTranscript()) || [];
  const turns = log.slice(S.currentStartLen).filter((t) => {
    const s = (t.speaker || '').toLowerCase();
    return !s.startsWith('interviewer'); // candidate / speaker 2 / etc.
  });
  return turns.map((t) => t.text).join(' ').trim();
}

// ---------------------------------------------------------------------------
// Watcher: react INSTANTLY to live transcript changes
//   - candidate added text  -> debounce ~SILENCE_MS then verify (they paused)
//   - interviewer added text -> verify NOW (they're moving on; lock briefly)
// ---------------------------------------------------------------------------
function watchTranscript() {
  if (!S.running || !S.current) return;
  const log = (window.getTranscript && window.getTranscript()) || [];
  if (log.length === S.lastSeenLen) return;

  const newTurns = log.slice(S.lastSeenLen);
  S.lastSeenLen = log.length;

  // Did any of the new turns come from the Interviewer? If so, the recruiter has
  // moved on — verify the candidate's answer right now.
  const interviewerSpoke = newTurns.some((t) =>
    (t.speaker || '').toLowerCase().startsWith('interviewer'));

  clearTimeout(S.silenceTimer);
  if (interviewerSpoke) {
    tick();
  } else {
    // Candidate added text — wait for a brief silence before evaluating.
    S.silenceTimer = setTimeout(() => tick(), SILENCE_MS);
  }
}

// ---------------------------------------------------------------------------
// Tick: verify the current answer, auto-advance when satisfied
// ---------------------------------------------------------------------------
async function tick(forced = false) {
  if (!S.sessionId || S.ticking || S.fetchingNext || !S.current || !S.running) return;
  if (Date.now() < S.advanceLockUntil) return;
  const log = (window.getTranscript && window.getTranscript()) || [];
  if (!forced && log.length === S.lastTickedLen) return;
  const answer = capturedAnswer();
  if (!forced && answer.length < MIN_ANSWER_CHARS) return;

  S.lastTickedLen = log.length;
  S.ticking = true;
  try {
    const res = await fetch('/assist/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: S.sessionId, question: S.current.question, answer }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus(data.error || 'Verification failed.', 'error'); return; }
    renderVerdict(data, answer);
    if (data.satisfied) await advance(data, answer);
  } catch {
    setStatus('Network error during verification.', 'error');
  } finally {
    S.ticking = false;
  }
}

const VERDICT_KIND = {
  Strong: 'ok', Adequate: 'ok',
  Weak: 'weak', Vague: 'weak',
  'Off-topic': 'bad',
};

function renderVerdict(data, answer) {
  const verdict = data.verdict || (data.satisfied ? 'OK' : 'Weak');
  const kind = VERDICT_KIND[verdict] || (data.satisfied ? 'ok' : 'weak');
  a.lastVerdict.textContent = verdict;
  a.lastVerdict.dataset.kind = kind;
  a.lastFb.textContent = data.feedback || '';
  if (answer) { a.lastQuote.textContent = answer; show(a.lastQuote); }
  if (data.followUp && !data.satisfied) {
    a.lastFollowup.textContent = data.followUp;
    show(a.lastFollowup);
    a.lastFollowup.onclick = async () => {
      try { await navigator.clipboard.writeText(data.followUp); } catch {}
      a.lastFollowup.style.borderColor = 'var(--candidate)';
      setTimeout(() => (a.lastFollowup.style.borderColor = ''), 800);
    };
  } else hide(a.lastFollowup);
}

async function advance(verifyData, answer) {
  // Brief lock so we don't immediately re-advance off the same answer text.
  S.advanceLockUntil = Date.now() + ADVANCE_LOCK_MS;
  clearTimeout(S.silenceTimer);

  S.history.push({
    category: S.current.category || '',
    question: S.current.question,
    answer: answer || capturedAnswer() || '',
    verdict: (verifyData && verifyData.verdict) || 'Adequate',
    feedback: (verifyData && verifyData.feedback) || '',
  });
  renderHistory();
  await fetchNextQuestion();
}

// ---------------------------------------------------------------------------
// History: rich Q + A + verdict + feedback per item
// ---------------------------------------------------------------------------
const HISTORY_VERDICT_KIND = {
  Strong: 'ok', Adequate: 'ok',
  Weak: 'weak', Vague: 'weak',
  'Off-topic': 'bad',
  Skipped: 'skip',
  'Manually accepted': 'ok',
};

function renderHistory() {
  a.queue.innerHTML = '';
  S.history.forEach((h, i) => {
    const kind = HISTORY_VERDICT_KIND[h.verdict] || 'ok';
    const item = document.createElement('div');
    item.className = 'qaItem';

    const head = document.createElement('div');
    head.className = 'qaItem__head';
    const num = document.createElement('span');
    num.className = 'qaItem__num';
    num.textContent = i + 1;
    const cat = document.createElement('span');
    cat.className = 'qaItem__cat';
    cat.textContent = h.category || '—';
    const verdict = document.createElement('span');
    verdict.className = 'qaItem__verdict';
    verdict.dataset.kind = kind;
    verdict.textContent = h.verdict || '—';
    head.appendChild(num); head.appendChild(cat); head.appendChild(verdict);

    const q = document.createElement('p');
    q.className = 'qaItem__q';
    q.textContent = h.question || '';

    item.appendChild(head);
    item.appendChild(q);

    if ((h.answer || '').trim()) {
      const ans = document.createElement('p');
      ans.className = 'qaItem__a';
      ans.textContent = h.answer.trim();
      item.appendChild(ans);
    }
    if ((h.feedback || '').trim()) {
      const fb = document.createElement('p');
      fb.className = 'qaItem__fb';
      fb.textContent = h.feedback.trim();
      item.appendChild(fb);
    }

    a.queue.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Manual controls
// ---------------------------------------------------------------------------
async function manualMarkAnswered() {
  if (!S.current || !S.running) return;
  const answer = capturedAnswer();
  await advance({ verdict: 'Manually accepted', feedback: '' }, answer);
}

async function manualSkip() {
  if (!S.current || !S.running) return;
  S.history.push({
    category: S.current.category || '',
    question: S.current.question,
    answer: capturedAnswer() || '',
    verdict: 'Skipped',
    feedback: '',
  });
  renderHistory();
  await fetchNextQuestion();
}

function copyCurrentQuestion() {
  if (!S.current) return;
  navigator.clipboard.writeText(S.current.question).catch(() => {});
  a.askQ.style.color = 'var(--candidate)';
  setTimeout(() => (a.askQ.style.color = ''), 800);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
a.start.addEventListener('click', startInterview);
a.refresh.addEventListener('click', () => tick(/*forced*/ true));
a.clientSelect.addEventListener('change', onClientChange);
a.jdSelect.addEventListener('change', onJdChange);
a.newClientBtn.addEventListener('click', () => { show(a.newClientRow); a.newClientName.focus(); });
a.saveClientBtn.addEventListener('click', saveClient);
a.newJdBtn.addEventListener('click', () => { show(a.newJdRow); a.newJdTitle.focus(); });
a.newJdFile.addEventListener('change', onJdFileChange);
a.saveJdBtn.addEventListener('click', saveJd);
a.askDone.addEventListener('click', manualMarkAnswered);
a.askSkip.addEventListener('click', manualSkip);
a.askFinish.addEventListener('click', endInterviewManual);
a.askQ.addEventListener('click', copyCurrentQuestion);
window.addEventListener('beforeunload', () => {
  clearInterval(S.safetyTimer);
  clearInterval(S.watcherTimer);
  clearTimeout(S.silenceTimer);
});

loadClients();
