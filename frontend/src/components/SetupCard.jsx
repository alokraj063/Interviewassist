import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const NEW = '__new__';

export default function SetupCard({
  clientId, jdId, onClientChange, onJdChange,
  resumeFile, onResumeFile, callMode, onCallMode,
  starting, onStart, status,
}) {
  const [clients, setClients] = useState([]);
  const [jds, setJds] = useState([]);
  const [newClient, setNewClient] = useState({ open: false, name: '' });
  const [newJd, setNewJd]         = useState({ open: false, title: '', text: '', file: null });

  // Load clients on mount
  useEffect(() => { loadClients(); }, []);
  useEffect(() => { loadJds(); }, [clientId]);

  async function loadClients(selectId) {
    try {
      const data = await api.listClients();
      if (data.ok) setClients(data.clients);
      if (selectId) onClientChange(selectId);
    } catch {}
  }
  async function loadJds(selectId) {
    if (!clientId) { setJds([]); return; }
    try {
      const data = await api.listJds(clientId);
      if (data.ok) setJds(data.jds);
      if (selectId) onJdChange(selectId);
    } catch {}
  }

  function clientPicked(v) {
    if (v === NEW) { onClientChange(''); setNewClient({ open: true, name: '' }); return; }
    setNewClient({ open: false, name: '' });
    onClientChange(v);
  }
  function jdPicked(v) {
    if (v === NEW) { onJdChange(''); setNewJd({ open: true, title: '', text: '', file: null }); return; }
    setNewJd({ open: false, title: '', text: '', file: null });
    onJdChange(v);
  }
  async function saveClient() {
    if (!newClient.name.trim()) return;
    const data = await api.createClient(newClient.name.trim());
    if (data.ok) { setNewClient({ open: false, name: '' }); await loadClients(data.client.id); }
  }
  async function saveJd() {
    if (!newJd.title.trim()) return;
    const fd = new FormData();
    fd.append('client_id', clientId || '');
    fd.append('title', newJd.title.trim());
    fd.append('jd_text', newJd.text || '');
    if (newJd.file) fd.append('jd_file', newJd.file);
    const data = await api.createJd(fd);
    if (data.ok) { setNewJd({ open: false, title: '', text: '', file: null }); await loadJds(data.jd.id); }
  }

  return (
    <section className="card">
      <div className="card__title">Set up the call</div>

      <div className="field">
        <span>Client</span>
        <div className="selectRow">
          <select value={clientId || ''} onChange={(e) => clientPicked(e.target.value)}>
            <option value="">(No client)</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW}>＋ New client…</option>
          </select>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewClient({ open: true, name: '' })}>＋ New</button>
        </div>
      </div>
      {newClient.open && (
        <div className="inlineNew">
          <input type="text" placeholder="Client name"
            value={newClient.name} onChange={(e) => setNewClient((s) => ({ ...s, name: e.target.value }))} />
          <button type="button" className="btn btn--sm" onClick={saveClient}>Save client</button>
        </div>
      )}

      <div className="field">
        <span>Job description (JD) <small>— reused across candidates</small></span>
        <div className="selectRow">
          <select value={jdId || ''} onChange={(e) => jdPicked(e.target.value)}>
            <option value="">(No JD)</option>
            {jds.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
            <option value={NEW}>＋ New JD…</option>
          </select>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNewJd({ open: true, title: '', text: '', file: null })}>＋ New</button>
        </div>
      </div>
      {newJd.open && (
        <div className="inlineNew">
          <input type="text" placeholder="Role title (e.g. Senior Backend Engineer)"
            value={newJd.title} onChange={(e) => setNewJd((s) => ({ ...s, title: e.target.value }))} />
          <textarea rows={3} placeholder="Paste the JD text — or upload a PDF/Word file below."
            value={newJd.text} onChange={(e) => setNewJd((s) => ({ ...s, text: e.target.value }))} />
          <input type="file" accept=".pdf,.docx,.txt"
            onChange={(e) => {
              const f = e.target.files[0] || null;
              setNewJd((s) => ({ ...s, file: f, title: s.title || (f?.name || '').replace(/\.[^.]+$/, '') }));
            }} />
          <button type="button" className="btn btn--sm" onClick={saveJd}>Save JD</button>
        </div>
      )}

      <label className="field">
        <span>Candidate resume <small>— PDF, DOCX, or TXT</small></span>
        <input type="file" accept=".pdf,.docx,.txt"
          onChange={(e) => onResumeFile(e.target.files[0] || null)} />
        {resumeFile && <small style={{ color: 'var(--muted)' }}>Selected: {resumeFile.name}</small>}
      </label>

      <div className="field">
        <span>Call type</span>
        <div className="modeToggle" role="radiogroup" aria-label="Call type"
             title="VC: share a Teams/Zoom/Meet tab. Phone: candidate on speakerphone, captured via your mic.">
          <label><input type="radio" name="callMode" value="vc" checked={callMode === 'vc'} onChange={() => onCallMode('vc')} /> VC tab</label>
          <label><input type="radio" name="callMode" value="phone" checked={callMode === 'phone'} onChange={() => onCallMode('phone')} /> Phone</label>
        </div>
      </div>

      <button className="btn btn--primary btn--block" onClick={onStart} disabled={starting}>
        ▶ Start interview
      </button>
      {status && <div className="assist__status" data-kind={status.kind || ''}>{status.text}</div>}
    </section>
  );
}
