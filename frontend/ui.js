// Shared render helpers used by both the live co-pilot (assist.js) and the
// saved-interview viewer (library.js). Exposed as window.IAUI.

const FIELD_ROWS = [
  ['current_position', 'Current Position'],
  ['current_company', 'Current Company'],
  ['current_location', 'Current Location'],
  ['current_salary', 'Current Salary'],
  ['expected_salary', 'Expected Salary'],
];

// Render a list of questions as click-to-copy chips.
function renderChips(container, questions) {
  container.innerHTML = '';
  (questions || []).forEach((q) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.type = 'button';
    btn.textContent = q;
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(q); } catch {}
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 900);
    });
    container.appendChild(btn);
  });
}

// Fill a fields <table>. Builds the rows itself if the table is empty (library
// detail); reuses pre-defined rows when present (the live panel's table).
function renderFieldsTable(table, fields) {
  fields = fields || {};
  let rows = table.querySelectorAll('tr');
  if (!rows.length) {
    FIELD_ROWS.forEach(([k, label]) => {
      const tr = document.createElement('tr');
      tr.dataset.k = k;
      tr.innerHTML = `<th>${label}</th><td>—</td>`;
      table.appendChild(tr);
    });
    rows = table.querySelectorAll('tr');
  }
  rows.forEach((row) => {
    const td = row.querySelector('td');
    const val = (fields[row.dataset.k] || '').trim();
    td.textContent = val || '—';
    td.classList.toggle('filled', !!val);
  });
}

function scoreColor(v) {
  return v >= 70 ? 'var(--candidate)' : v >= 45 ? '#eab308' : '#ef4444';
}

// Apply a score object to a set of ring/bar elements.
function applyScore(els, score) {
  score = score || {};
  if (typeof score.overall === 'number') {
    els.overall.textContent = score.overall;
    els.ring.style.setProperty('--val', score.overall);
    els.ring.style.setProperty('--c', scoreColor(score.overall));
  }
  els.barComm.style.width = `${score.communication || 0}%`;
  els.barRel.style.width = `${score.relevance || 0}%`;
  els.barDepth.style.width = `${score.depth || 0}%`;
}

// Map a saved turn's speaker label to a .turn accent class.
function speakerClass(speaker) {
  const s = (speaker || '').toLowerCase();
  if (s.startsWith('interviewer')) return 'turn--interviewer';
  if (s.startsWith('candidate')) return 'turn--candidate';
  const m = /speaker\s*(\d+)/i.exec(speaker || '');
  return m ? `turn--s${m[1]}` : '';
}

// Render saved transcript turns into a container (read-only).
function renderTranscript(container, turns) {
  container.innerHTML = '';
  if (!turns || !turns.length) {
    container.innerHTML = '<p class="hint">No transcript saved for this interview.</p>';
    return;
  }
  turns.forEach((t) => {
    const row = document.createElement('div');
    row.className = `turn ${speakerClass(t.speaker)}`.trim();
    const time = t.time ? `<span class="turn__time">${t.time}</span>` : '';
    row.innerHTML = `<div class="turn__meta"><span class="turn__who"></span>${time}</div>`
      + '<div class="turn__text"></div>';
    row.querySelector('.turn__who').textContent = t.speaker || 'Speaker';
    row.querySelector('.turn__text').textContent = t.text || '';
    container.appendChild(row);
  });
}

// Colour for a verdict label — handles both fit verdicts ("Strong fit", "Weak
// fit", "Not enough info") and live recommendations ("Strong yes" … "Strong no").
function verdictColor(label) {
  const s = (label || '').toLowerCase();
  if (s.includes('strong yes') || s.includes('strong fit')) return 'var(--candidate)';
  if (s.includes('yes') || s.includes('possible fit')) return 'var(--interviewer)';
  if (s.includes('strong no') || s.includes('weak fit')) return '#ef4444';
  if (s.includes('no')) return '#f97316';
  return '#eab308'; // borderline / not enough info / unknown
}

// Render the recommendation badge + rationale. els = { badge, rationale }.
function renderRecommendation(els, rec) {
  rec = rec || {};
  const verdict = (rec.verdict || '').trim();
  els.badge.textContent = verdict || '—';
  els.badge.style.background = verdict ? verdictColor(verdict) : 'var(--border)';
  els.rationale.textContent = rec.rationale || '';
  return !!verdict;
}

// Render a list of red-flag / watch-out strings. Returns the count.
function renderFlags(container, flags) {
  container.innerHTML = '';
  (flags || []).forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    container.appendChild(li);
  });
  return (flags || []).length;
}

window.IAUI = {
  renderChips, renderFieldsTable, applyScore, scoreColor, speakerClass, renderTranscript,
  verdictColor, renderRecommendation, renderFlags,
};
