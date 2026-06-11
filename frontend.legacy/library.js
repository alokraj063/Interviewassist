// Library: browse saved interviews grouped by Client → JD, and view any one's
// stored transcript + co-pilot analysis. Read-only. Reuses window.IAUI helpers.

const lib = {
  navLive: document.getElementById('navLive'),
  navLibrary: document.getElementById('navLibrary'),
  workspace: document.querySelector('.workspace'),
  view: document.getElementById('libraryView'),
  groups: document.getElementById('libraryGroups'),
  detail: document.getElementById('libraryDetail'),
  refresh: document.getElementById('libraryRefresh'),
};

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString([], {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function scoreBadge(v) {
  if (typeof v !== 'number') return '';
  const span = document.createElement('span');
  span.className = 'scoreBadge';
  span.textContent = v;
  span.style.background = IAUI.scoreColor(v);
  return span.outerHTML;
}

// ---------------------------------------------------------------------------
// View toggle
// ---------------------------------------------------------------------------
function showView(view) {
  const live = view !== 'library';
  lib.workspace.classList.toggle('hidden', !live);
  lib.view.classList.toggle('hidden', live);
  lib.navLive.classList.toggle('is-active', live);
  lib.navLibrary.classList.toggle('is-active', !live);
  if (!live) loadLibrary();
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------
async function loadLibrary() {
  lib.groups.innerHTML = '<p class="hint" style="padding:12px">Loading…</p>';
  let rows = [];
  try {
    const res = await fetch('/api/interviews');
    const data = await res.json();
    if (data.ok) rows = data.interviews;
  } catch {}

  if (!rows.length) {
    lib.groups.innerHTML = '<p class="hint" style="padding:12px">No saved interviews yet. '
      + 'Start a call from the Live tab — it will appear here when you stop.</p>';
    return;
  }

  // Group by client → jd (nulls → Unassigned / No JD).
  const byClient = new Map();
  rows.forEach((r) => {
    const c = r.client_name || 'Unassigned';
    const j = r.jd_title || 'No JD';
    if (!byClient.has(c)) byClient.set(c, new Map());
    const jdMap = byClient.get(c);
    if (!jdMap.has(j)) jdMap.set(j, []);
    jdMap.get(j).push(r);
  });

  lib.groups.innerHTML = '';
  for (const [client, jdMap] of byClient) {
    const cEl = document.createElement('div');
    cEl.className = 'libGroup';
    cEl.innerHTML = `<div class="libGroup__client">${escapeHtml(client)}</div>`;
    for (const [jd, items] of jdMap) {
      const jEl = document.createElement('div');
      jEl.className = 'libGroup__jd';
      jEl.innerHTML = `<div class="libGroup__jdTitle">${escapeHtml(jd)}</div>`;
      items.forEach((r) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'libItem';
        item.innerHTML =
          `<span class="libItem__name">${escapeHtml(r.candidate_name || '(unnamed candidate)')}</span>`
          + `<span class="libItem__meta">${fmtDate(r.started_at)} · ${r.call_mode}</span>`
          + (r.rec_verdict ? verdictBadgeHtml(r.rec_verdict) : scoreBadge(r.score_overall));
        item.addEventListener('click', () => {
          lib.groups.querySelectorAll('.libItem').forEach((n) => n.classList.remove('is-active'));
          item.classList.add('is-active');
          loadDetail(r.id);
        });
        jEl.appendChild(item);
      });
      cEl.appendChild(jEl);
    }
    lib.groups.appendChild(cEl);
  }
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function verdictBadgeHtml(label, lg) {
  if (!label) return '';
  return `<span class="verdictBadge${lg ? ' verdictBadge--lg' : ''}" `
    + `style="background:${IAUI.verdictColor(label)}">${escapeHtml(label)}</span>`;
}

function evidenceListHtml(items, marker, cls) {
  if (!items || !items.length) return '';
  return `<ul class="evidence__list ${cls}">`
    + items.map((t) => `<li>${escapeHtml(`${marker} ${t}`)}</li>`).join('') + '</ul>';
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------
async function loadDetail(id) {
  lib.detail.innerHTML = '<div class="empty"><p class="hint">Loading…</p></div>';
  let it = null;
  try {
    const res = await fetch(`/api/interviews/${id}`);
    const data = await res.json();
    if (data.ok) it = data.interview;
  } catch {}
  if (!it) { lib.detail.innerHTML = '<div class="empty"><p class="hint">Could not load interview.</p></div>'; return; }

  const ctx = [it.client_name, it.jd_title, fmtDate(it.started_at), `${it.call_mode} call`]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const hasScore = typeof it.score.overall === 'number';
  const rec = it.recommendation || {};
  const flags = it.red_flags || [];
  const hasSnapshot = it.summary || it.fit_verdict || (it.strengths || []).length || (it.gaps || []).length;

  lib.detail.innerHTML = `
    <div class="detailHead">
      <h2>${escapeHtml(it.candidate_name || '(unnamed candidate)')}</h2>
      <p class="hint">${ctx}</p>
    </div>
    ${rec.verdict ? `<section class="card card--rec"><div class="card__title">Recommendation</div>
      <div class="rec">${verdictBadgeHtml(rec.verdict, true)}<p class="rec__rationale">${escapeHtml(rec.rationale || '')}</p></div></section>` : ''}
    ${flags.length ? `<section class="card" id="dFlagsCard"><div class="card__title">⚠ Watch-outs</div>
      <ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul></section>` : ''}
    ${hasSnapshot ? `<section class="card"><div class="card__title">Candidate snapshot ${verdictBadgeHtml(it.fit_verdict)}</div>
      <p class="snapshot">${escapeHtml(it.summary || '')}</p>
      <div class="evidence">${evidenceListHtml(it.strengths, '✓', 'evidence__list--good')}${evidenceListHtml(it.gaps, '✗', 'evidence__list--bad')}</div></section>` : ''}
    ${(it.opening_questions || []).length ? `<section class="card"><div class="card__title">Opening questions</div><div class="chips" id="dOpening"></div></section>` : ''}
    ${hasScore ? `
    <section class="card"><div class="card__title">How it went</div>
      <div class="score">
        <div class="score__ring" id="dRing"><span id="dOverall">–</span></div>
        <div class="score__bars">
          <div class="bar"><label>Communication</label><div class="bar__track"><i id="dComm"></i></div></div>
          <div class="bar"><label>Relevance</label><div class="bar__track"><i id="dRel"></i></div></div>
          <div class="bar"><label>Depth</label><div class="bar__track"><i id="dDepth"></i></div></div>
        </div>
      </div>
      ${it.feedback ? `<p class="feedback">${escapeHtml(it.feedback)}</p>` : ''}
    </section>` : (it.feedback ? `<section class="card"><div class="card__title">Feedback</div><p class="feedback">${escapeHtml(it.feedback)}</p></section>` : '')}
    ${(it.suggested_questions || []).length ? `<section class="card"><div class="card__title">Suggested questions (last)</div><div class="chips" id="dNext"></div></section>` : ''}
    <section class="card"><div class="card__title">Candidate details</div><table class="fields" id="dFields"></table></section>
    <section class="card"><div class="card__title">Transcript</div><div class="transcript transcript--static" id="dTranscript"></div></section>
  `;

  if ((it.opening_questions || []).length) IAUI.renderChips(lib.detail.querySelector('#dOpening'), it.opening_questions);
  if (hasScore) {
    IAUI.applyScore({
      ring: lib.detail.querySelector('#dRing'), overall: lib.detail.querySelector('#dOverall'),
      barComm: lib.detail.querySelector('#dComm'), barRel: lib.detail.querySelector('#dRel'),
      barDepth: lib.detail.querySelector('#dDepth'),
    }, it.score);
  }
  if ((it.suggested_questions || []).length) IAUI.renderChips(lib.detail.querySelector('#dNext'), it.suggested_questions);
  IAUI.renderFieldsTable(lib.detail.querySelector('#dFields'), it.fields || {});
  IAUI.renderTranscript(lib.detail.querySelector('#dTranscript'), it.turns || []);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
lib.navLive.addEventListener('click', () => showView('live'));
lib.navLibrary.addEventListener('click', () => showView('library'));
lib.refresh.addEventListener('click', loadLibrary);
