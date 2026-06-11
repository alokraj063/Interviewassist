import { useEffect, useRef } from 'react';

const speakerClass = (speaker) => {
  const s = (speaker || '').toLowerCase();
  if (s.startsWith('interviewer')) return 'turn--interviewer';
  if (s.startsWith('candidate'))   return 'turn--candidate';
  const m = /speaker\s*(\d+)/i.exec(speaker || '');
  return m ? `turn--s${m[1]}` : '';
};

export default function Transcript({ log, livePreviews, onCopy, onClear, onStop, stopDisabled }) {
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, livePreviews]);

  const previews = Object.values(livePreviews || {});
  const isEmpty = log.length === 0 && previews.length === 0;

  return (
    <section className="board">
      <div className="controls">
        <button className="btn" onClick={onStop} disabled={stopDisabled}>■ Stop interview</button>
        <div className="spacer" />
        <button className="btn btn--ghost" onClick={onCopy}>Copy</button>
        <button className="btn btn--ghost" onClick={onClear}>Clear</button>
      </div>

      <div className="transcript" ref={scrollRef}>
        {isEmpty ? (
          <div className="empty">
            <h2>Ready when you are</h2>
            <ol>
              <li>Pick a Client + JD, drop the candidate's resume on the right, click <b>▶ Start interview</b>.</li>
              <li>The browser will prompt for your <b>microphone</b> and (for VC calls) the <b>tab to share</b> — tick "Share tab audio".</li>
              <li>Talk — every turn is transcribed live. The right panel tells you what to ask next and grades each answer.</li>
            </ol>
          </div>
        ) : (
          <>
            {log.map((t, i) => (
              <div key={i} className={`turn ${speakerClass(t.speaker)}`}>
                <div className="turn__meta">
                  <span className="turn__who">{t.speaker}</span>
                  {t.time && <span className="turn__time">{t.time}</span>}
                </div>
                <div className="turn__text">{t.text}</div>
              </div>
            ))}
            {previews.map((p, i) => (
              <div key={`p${i}`} className={`turn ${speakerClass(p.speaker)} turn--interim`}>
                <div className="turn__meta">
                  <span className="turn__who">{p.speaker}</span>
                </div>
                <div className="turn__text">{p.text}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
