// Interview Assist co-pilot (GPT-4o-mini) + interview/setup lifecycle.
//
// 1. Recruiter picks a Client + JD (reused across candidates), optional candidate
//    name + resume -> Start assist -> opening questions.
// 2. While the call runs, every ~30s the running transcript (window.getTranscript())
//    is POSTed to /assist/analyze -> score, feedback, next questions, fields.
//
// An "interview" row (created via window.ensureInterview) ties the live transcript,
// the co-pilot session, and the saved record together under one id.
//
// All OpenAI calls happen on the backend; the key never reaches the browser.

const ASSIST_INTERVAL_MS = 30000;
const NEW = '__new__';

const a = {
  start: document.getElementById('assistStart'),
  refresh: document.getElementById('assistRefresh'),
  status: document.getElementById('assistStatus'),
  clientSelect: document.getElementById('clientSelect'),
  jdSelect: document.getElementById('jdSelect'),
  candidateName: document.getElementById('candidateName'),
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
  jdText: document.getElementById('jdText'),
  jdFile: document.getElementById('jdFile'),
  resumeText: document.getElementById('resumeText'),
  resumeFile: document.getElementById('resumeFile'),
  snapshotCard: document.getElementById('assistSnapshotCard'),
  snapshot: document.getElementById('assistSnapshot'),
  fitVerdict: document.getElementById('assistFitVerdict'),
  strengths: document.getElementById('assistStrengths'),
  gaps: document.getElementById('assistGaps'),
  openingCard: document.getElementById('assistOpeningCard'),
  opening: document.getElementById('assistOpening'),
  recCard: document.getElementById('assistRecCard'),
  recVerdict: document.getElementById('assistRecVerdict'),
  recRationale: document.getElementById('assistRecRationale'),
  flagsCard: document.getElementById('assistFlagsCard'),
  flags: document.getElementById('assistFlags'),
  scoreCard: document.getElementById('assistScoreCard'),
  ring: document.getElementById('scoreRing'),
  overall: document.getElementById('scoreOverall'),
  barComm: document.getElementById('barComm'),
  barRel: document.getElementById('barRel'),
  barDepth: document.getElementById('barDepth'),
  feedback: document.getElementById('assistFeedback'),
  nextCard: document.getElementById('assistNextCard'),
  next: document.getElementById('assistNext'),
  fieldsCard: document.getElementById('assistFieldsCard'),
  fields: document.getElementById('assistFields'),
};

let assistSessionId = null;
let analyzeTimer = null;
let lastAnalyzedLen = 0;
let analyzing = false;

function setStatus(text, kind = '') {
  a.status.textContent = text || '';
  a.status.dataset.kind = kind;
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

// A real selection only — treat "(none)" ('') and "＋ New" sentinel as unset.
function realValue(sel) {
  const v = sel.value;
  return v && v !== NEW ? v : '';
}

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
    show(a.newClientRow);
    a.newClientName.focus();
  } else {
    hide(a.newClientRow);
  }
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
      a.newClientName.value = '';
      hide(a.newClientRow);
      await loadClients(data.client.id);
    } else {
      setStatus(data.error || 'Could not create client.', 'error');
    }
  } catch { setStatus('Network error creating client.', 'error'); }
}

function onJdChange() {
  if (a.jdSelect.value === NEW) {
    a.jdSelect.value = '';
    show(a.newJdRow);
    a.newJdTitle.focus();
  } else {
    hide(a.newJdRow);
  }
}

// Prefill the JD title from an uploaded file's name when the title is still empty.
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
    // Multipart so a pasted JD and/or an uploaded PDF/Word file both work.
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
    } else {
      setStatus(data.error || 'Could not create JD.', 'error');
    }
  } catch { setStatus('Network error creating JD.', 'error'); }
}

// ---------------------------------------------------------------------------
// Interview lifecycle (shared with app.js via window)
// ---------------------------------------------------------------------------
window.interview = null; // { id, clientId, jdId, local? }

window.ensureInterview = async function () {
  if (window.interview) return window.interview.id;

  const clientId = realValue(a.clientSelect);
  const jdId = realValue(a.jdSelect);
  const candidate = (a.candidateName.value || '').trim();
  const modeEl = document.querySelector('input[name="callMode"]:checked');
  const call_mode = (modeEl && modeEl.value) || 'vc';

  // A brand-new interview — start from a clean slate.
  if (window.resetTranscript) window.resetTranscript();
  resetAssistCards();

  try {
    const res = await fetch('/api/interviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId || null, jd_id: jdId || null, candidate_name: candidate, call_mode }),
    });
    const data = await res.json();
    if (data.ok && data.interview) {
      window.interview = { id: data.interview.id, clientId, jdId };
      return window.interview.id;
    }
  } catch {}

  // Fallback: a local timestamp id so transcription still saves to a file.
  window.interview = { id: (window.makeSessionId ? window.makeSessionId() : Date.now().toString()), clientId, jdId, local: true };
  return window.interview.id;
};

window.endInterview = async function () {
  const it = window.interview;
  window.interview = null;
  assistSessionId = null;
  clearInterval(analyzeTimer);
  a.refresh.disabled = true;
  a.start.disabled = false;
  if (it && !it.local) {
    try { await fetch(`/api/interviews/${it.id}/end`, { method: 'POST' }); } catch {}
  }
};

// Fill a <ul> with items prefixed by a marker; hide it when empty.
function renderEvidence(ul, items, marker) {
  ul.innerHTML = '';
  (items || []).forEach((t) => {
    const li = document.createElement('li');
    li.textContent = `${marker} ${t}`;
    ul.appendChild(li);
  });
  ul.hidden = !(items || []).length;
}

function resetAssistCards() {
  [a.snapshotCard, a.openingCard, a.recCard, a.flagsCard, a.scoreCard, a.nextCard, a.fieldsCard]
    .forEach(hide);
  a.snapshot.textContent = '';
  a.fitVerdict.hidden = true; a.fitVerdict.textContent = '';
  a.strengths.innerHTML = ''; a.strengths.hidden = true;
  a.gaps.innerHTML = ''; a.gaps.hidden = true;
  a.opening.innerHTML = '';
  a.recVerdict.textContent = '—'; a.recRationale.textContent = '';
  a.flags.innerHTML = '';
  a.next.innerHTML = '';
  a.overall.textContent = '–';
  a.feedback.textContent = '';
  a.barComm.style.width = a.barRel.style.width = a.barDepth.style.width = '0%';
  IAUI.renderFieldsTable(a.fields, {});
  lastAnalyzedLen = 0;
}

// ---------------------------------------------------------------------------
// Start: create/attach the interview, get snapshot + opening questions
// ---------------------------------------------------------------------------
async function startAssist() {
  a.start.disabled = true;
  setStatus('Setting up…');

  const id = await window.ensureInterview();

  const fd = new FormData();
  fd.append('interview_id', id);
  fd.append('jd_text', a.jdText.value || '');
  fd.append('resume_text', a.resumeText.value || '');
  if (a.jdFile.files[0]) fd.append('jd_file', a.jdFile.files[0]);
  if (a.resumeFile.files[0]) fd.append('resume_file', a.resumeFile.files[0]);

  setStatus('Analysing JD & resume…');
  try {
    const res = await fetch('/assist/start', { method: 'POST', body: fd });
    const data = await res.json();
    if (!data.ok) {
      setStatus(data.error || 'Could not start the co-pilot.', 'error');
      a.start.disabled = false;
      return;
    }
    assistSessionId = data.sessionId;
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
    if (data.openingQuestions && data.openingQuestions.length) {
      IAUI.renderChips(a.opening, data.openingQuestions);
      show(a.openingCard);
    }
    show(a.recCard); show(a.scoreCard); show(a.nextCard); show(a.fieldsCard);
    a.refresh.disabled = false;
    setStatus('Co-pilot live · updates every 30s from the live transcript.');

    lastAnalyzedLen = 0;
    clearInterval(analyzeTimer);
    analyzeTimer = setInterval(maybeAnalyze, ASSIST_INTERVAL_MS);
  } catch (err) {
    setStatus('Network error starting the co-pilot.', 'error');
    a.start.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Analyze: only when there's new transcript (saves tokens)
// ---------------------------------------------------------------------------
function transcriptText() {
  const log = (window.getTranscript && window.getTranscript()) || [];
  return log.map((t) => `${t.speaker}: ${t.text}`).join('\n');
}

async function maybeAnalyze() {
  if (!assistSessionId || analyzing) return;
  const log = (window.getTranscript && window.getTranscript()) || [];
  if (log.length === lastAnalyzedLen) return; // nothing new since last run
  await analyze();
}

async function analyze() {
  if (!assistSessionId) return;
  const log = (window.getTranscript && window.getTranscript()) || [];
  analyzing = true;
  setStatus('Analysing the conversation…');
  try {
    const res = await fetch('/assist/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: assistSessionId, transcript: transcriptText() }),
    });
    const data = await res.json();
    if (!data.ok) { setStatus(data.error || 'Analysis failed.', 'error'); return; }
    lastAnalyzedLen = log.length;
    renderAnalysis(data);
    setStatus('Updated · refreshes every 30s.');
  } catch (err) {
    setStatus('Network error during analysis.', 'error');
  } finally {
    analyzing = false;
  }
}

function renderAnalysis(data) {
  if (IAUI.renderRecommendation({ badge: a.recVerdict, rationale: a.recRationale }, data.recommendation)) {
    show(a.recCard);
  }
  const flagCount = IAUI.renderFlags(a.flags, data.redFlags);
  a.flagsCard.classList.toggle('hidden', flagCount === 0);
  IAUI.applyScore(
    { ring: a.ring, overall: a.overall, barComm: a.barComm, barRel: a.barRel, barDepth: a.barDepth },
    data.score || {},
  );
  if (data.feedback) a.feedback.textContent = data.feedback;
  if (data.suggestedQuestions) IAUI.renderChips(a.next, data.suggestedQuestions);
  IAUI.renderFieldsTable(a.fields, data.fields || {});
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
a.start.addEventListener('click', startAssist);
a.refresh.addEventListener('click', analyze); // manual refresh ignores the "new turns" gate
a.clientSelect.addEventListener('change', onClientChange);
a.jdSelect.addEventListener('change', onJdChange);
a.newClientBtn.addEventListener('click', () => { show(a.newClientRow); a.newClientName.focus(); });
a.saveClientBtn.addEventListener('click', saveClient);
a.newJdBtn.addEventListener('click', () => { show(a.newJdRow); a.newJdTitle.focus(); });
a.newJdFile.addEventListener('change', onJdFileChange);
a.saveJdBtn.addEventListener('click', saveJd);
window.addEventListener('beforeunload', () => clearInterval(analyzeTimer));

loadClients();
