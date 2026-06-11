import { useState, useCallback, useEffect } from 'react';
import Topbar from './components/Topbar.jsx';
import Banner from './components/Banner.jsx';
import Transcript from './components/Transcript.jsx';
import AssistPanel from './components/AssistPanel.jsx';
import Library from './components/Library.jsx';
import { useAudioCapture } from './hooks/useAudioCapture.js';
import { useInterviewFlow } from './hooks/useInterviewFlow.js';

// Theme preference. Light by default; persisted per-browser via localStorage so a
// user's choice survives reloads but never leaks across users (each browser/profile
// has its own localStorage namespace).
const THEME_KEY = 'ia-theme';
const readTheme = () => {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch { return 'light'; }
};

export default function App() {
  const [view, setView] = useState('live');           // 'live' | 'library'
  const [theme, setTheme] = useState(readTheme);
  const [clientId, setClientId] = useState('');
  const [jdId, setJdId] = useState('');
  const [resumeFile, setResumeFile] = useState(null);
  const [callMode, setCallMode] = useState('vc');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  // Audio + transcript
  const audio = useAudioCapture({ clientId, jdId });

  // Interview flow (reads the live transcript log to react instantly)
  const flow = useInterviewFlow({ transcriptLog: audio.transcriptLog });

  const onClientChange = useCallback((v) => { setClientId(v); setJdId(''); }, []);

  const handleStart = useCallback(async () => {
    if (!resumeFile) {
      flow.reset();
      alert('Please upload the candidate resume (PDF / DOCX / TXT) before starting.');
      return;
    }
    setStarting(true);
    try {
      // 1) Audio capture (browser will prompt for mic + tab share)
      await audio.start({ mode: callMode });
      // 2) Interview row was created inside audio.start via ensureInterview
      const interviewId = audio.interviewRef.current?.id;
      // 3) Kick off the assist flow
      await flow.startFlow({ interviewId, resumeFile });
    } catch (err) {
      // banner is already set inside audio.start
    } finally {
      setStarting(false);
    }
  }, [audio, callMode, flow, resumeFile]);

  const handleStop = useCallback(() => {
    audio.stop();
    flow.reset();
  }, [audio, flow]);

  const handleCopyTranscript = useCallback(async () => {
    const text = audio.transcriptLog.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    try { await navigator.clipboard.writeText(text); } catch {}
  }, [audio.transcriptLog]);

  const running = flow.running || audio.micState === 'live' || audio.callState === 'live';

  return (
    <div className="app">
      <Topbar
        view={view} onView={setView}
        micState={audio.micState} callState={audio.callState} callMode={callMode}
        theme={theme} onToggleTheme={toggleTheme}
      />
      <Banner banner={audio.banner} />

      {view === 'live' && (
        <main className="workspace">
          <Transcript
            log={audio.transcriptLog}
            livePreviews={audio.livePreviews}
            onCopy={handleCopyTranscript}
            onClear={audio.clearTranscript}
            onStop={handleStop}
            stopDisabled={!running}
          />
          <AssistPanel
            clientId={clientId} jdId={jdId}
            onClientChange={onClientChange} onJdChange={setJdId}
            resumeFile={resumeFile} onResumeFile={setResumeFile}
            callMode={callMode} onCallMode={setCallMode}
            starting={starting} onStart={handleStart}
            running={flow.running}
            snapshot={flow.snapshot}
            current={flow.current}
            history={flow.history}
            latest={flow.latest}
            finalScore={flow.finalScore}
            status={flow.status}
            onSkip={flow.skip}
            onMarkAnswered={flow.markAnswered}
            onEndScore={flow.endNow}
            onForceTick={flow.forceTick}
          />
        </main>
      )}

      {view === 'library' && <Library />}
    </div>
  );
}
