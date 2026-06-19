import { forwardRef } from "react";
import { videoUrl } from "@/hooks/useAsyncVideo";

/**
 * Authenticated, range-aware video player for a submission's per-question clip.
 * The token rides in the URL (the <video> element can't set headers); the API
 * streams the webm with Range support and writes a chain-of-custody audit row.
 */
export const VideoPlayer = forwardRef<HTMLVideoElement, {
  submissionId: string;
  promptIndex: number;
  captionsVtt?: string | null;
  onTimeUpdate?: (sec: number) => void;
}>(function VideoPlayer({ submissionId, promptIndex, captionsVtt, onTimeUpdate }, ref) {
  return (
    <video
      ref={ref}
      controls
      preload="metadata"
      className="w-full rounded bg-black aspect-video"
      src={videoUrl(submissionId, promptIndex)}
      onTimeUpdate={(e) => onTimeUpdate?.(Math.floor((e.target as HTMLVideoElement).currentTime))}
      data-testid={`av-video-${promptIndex}`}
    >
      {captionsVtt ? (
        <track
          kind="captions"
          srcLang="en"
          label="AI transcript"
          default
          src={`data:text/vtt;charset=utf-8,${encodeURIComponent(captionsVtt)}`}
        />
      ) : null}
      Your browser does not support video playback.
    </video>
  );
});
