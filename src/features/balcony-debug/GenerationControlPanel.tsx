import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProgress,
  startGeneration,
  pauseGeneration,
  resumeGeneration,
  cancelGeneration,
  retryFailedJobs,
  GenerationProgress,
} from "./balconyGenerationApi";
import "./GenerationControlPanel.css";

const POLL_INTERVAL_MS = 3000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

const hasAdminToken = Boolean(import.meta.env.VITE_BALCONY_ADMIN_TOKEN);

/**
 * Production admin control panel for the automated balcony viewpoint
 * generation pipeline — see cesium-demo/backend (a standalone service, run
 * separately with `npm run dev` inside that folder). Unlike the old debug
 * tools (LiveBalconyPositionDebug, manual Capture/Analyze buttons), the user
 * here never flies a camera, captures a screenshot, or runs an analysis by
 * hand — one click enqueues every viewpoint and a Puppeteer-driven worker
 * processes them all automatically. No building picker: the backend defaults
 * to its one seeded demo building, matching this app's single hardcoded
 * building transform.
 */
export function GenerationControlPanel() {
  const [isMinimized, setIsMinimized] = useState(true);
  const [position, setPosition] = useState({ top: 80, left: 1000 });
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshProgress = useCallback(async () => {
    try {
      const next = await fetchProgress();
      setProgress(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (isMinimized) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }
    void refreshProgress();
    pollRef.current = setInterval(() => void refreshProgress(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [isMinimized, refreshProgress]);

  async function runAction(action: () => Promise<unknown>) {
    setIsBusy(true);
    try {
      await action();
      await refreshProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsBusy(false);
    }
  }

  const dragState = useRef<{ dragging: boolean; offsetX: number; offsetY: number }>({
    dragging: false,
    offsetX: 0,
    offsetY: 0,
  });

  function onHeaderMouseDown(event: React.MouseEvent) {
    dragState.current = {
      dragging: true,
      offsetX: event.clientX - position.left,
      offsetY: event.clientY - position.top,
    };
  }

  useEffect(() => {
    function onMove(event: MouseEvent) {
      if (!dragState.current.dragging) return;
      setPosition({
        left: event.clientX - dragState.current.offsetX,
        top: event.clientY - dragState.current.offsetY,
      });
    }
    function onUp() {
      dragState.current.dragging = false;
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div className="generation-control-panel" style={{ top: position.top, left: position.left }}>
      <div className="generation-control-panel__header" onMouseDown={onHeaderMouseDown}>
        <span>Generation Control</span>
        <button
          type="button"
          className="minimize-btn"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setIsMinimized((value) => !value)}
        >
          {isMinimized ? "▢" : "—"}
        </button>
      </div>

      {!isMinimized && (
        <div className="generation-control-panel__body">
          {!hasAdminToken && (
            <p className="note">
              No admin token configured (VITE_BALCONY_ADMIN_TOKEN) — progress is read-only here;
              generation controls will fail with 401.
            </p>
          )}
          {error && <p className="note error">{error}</p>}

          {progress && (
            <>
              <div className="generation-control-panel__progress-bar">
                <div
                  className="generation-control-panel__progress-fill"
                  style={{ width: `${Math.round(progress.progressFraction * 100)}%` }}
                />
              </div>
              <div className="generation-control-panel__stats">
                <div>
                  <span>Completed</span>
                  <span>
                    {progress.completedViewpoints} / {progress.totalViewpoints}
                  </span>
                </div>
                <div>
                  <span>Remaining</span>
                  <span>{progress.remaining}</span>
                </div>
                <div>
                  <span>Failed</span>
                  <span>{progress.failedViewpoints}</span>
                </div>
                <div>
                  <span>ETA</span>
                  <span>
                    {progress.estimatedTimeRemainingMs !== null
                      ? formatDuration(progress.estimatedTimeRemainingMs)
                      : "—"}
                  </span>
                </div>
              </div>
              {progress.currentJob && (
                <div className="generation-control-panel__current-job">
                  Now {progress.currentJob.status}: Floor {progress.currentJob.floorNumber ?? "?"} —{" "}
                  {progress.currentJob.direction} Flat {progress.currentJob.flatNumber}
                </div>
              )}
              <div className="generation-control-panel__status-line">
                {progress.isPaused ? "⏸ Paused" : progress.isRunning ? "▶ Running" : "⏹ Idle"}
              </div>
            </>
          )}

          <div className="button-row">
            <button
              type="button"
              className="btn primary"
              disabled={isBusy}
              onClick={() => runAction(() => startGeneration())}
            >
              Generate Entire Building
            </button>
          </div>
          <div className="button-row">
            <button type="button" className="btn" disabled={isBusy} onClick={() => runAction(pauseGeneration)}>
              Pause
            </button>
            <button type="button" className="btn" disabled={isBusy} onClick={() => runAction(resumeGeneration)}>
              Resume
            </button>
            <button type="button" className="btn danger" disabled={isBusy} onClick={() => runAction(cancelGeneration)}>
              Cancel
            </button>
          </div>
          <div className="button-row">
            <button type="button" className="btn" disabled={isBusy} onClick={() => runAction(retryFailedJobs)}>
              Retry Failed
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
