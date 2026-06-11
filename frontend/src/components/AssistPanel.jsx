import SetupCard from './SetupCard.jsx';
import AskNextCard from './AskNextCard.jsx';
import LastAnswerCard from './LastAnswerCard.jsx';
import HistoryCard from './HistoryCard.jsx';
import SnapshotCard from './SnapshotCard.jsx';
import FinalScoreCard from './FinalScoreCard.jsx';

export default function AssistPanel({
  // setup props
  clientId, jdId, onClientChange, onJdChange,
  resumeFile, onResumeFile, callMode, onCallMode,
  starting, onStart,
  // flow state
  running, snapshot, current, history, latest, finalScore, status,
  onSkip, onMarkAnswered, onEndScore, onForceTick,
}) {
  const showSetup = !running && !finalScore;

  return (
    <aside className="assist">
      <div className="assist__head">
        <h2>Interview Assist</h2>
        {!showSetup && (
          <button className="btn btn--ghost btn--sm" onClick={onForceTick} disabled={!current}>
            ↻ Check now
          </button>
        )}
      </div>

      {showSetup && (
        <SetupCard
          clientId={clientId} jdId={jdId}
          onClientChange={onClientChange} onJdChange={onJdChange}
          resumeFile={resumeFile} onResumeFile={onResumeFile}
          callMode={callMode} onCallMode={onCallMode}
          starting={starting} onStart={onStart} status={status}
        />
      )}

      {!showSetup && status?.text && (
        <div className="assist__status" data-kind={status.kind || ''}>{status.text}</div>
      )}

      <AskNextCard current={current} history={history}
        onSkip={onSkip} onMarkAnswered={onMarkAnswered} onEndScore={onEndScore} />

      <LastAnswerCard latest={latest} hasCurrent={!!current} />

      <HistoryCard history={history} />

      <SnapshotCard snapshot={snapshot} />

      <FinalScoreCard finalScore={finalScore} />
    </aside>
  );
}
