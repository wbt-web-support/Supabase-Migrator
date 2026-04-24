"use client";

import { useEffect, useState } from "react";

const STAGES = [
  "Connecting to source database",
  "Introspecting schemas and tables",
  "Reading indexes, keys, and policies",
  "Analyzing destination state",
  "Generating migration SQL",
];

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export function PreviewLoader() {
  const [stageIdx, setStageIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const stageTimer = setInterval(() => {
      setStageIdx((i) => (i + 1) % STAGES.length);
    }, 2200);
    const elapsedTimer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 500);
    return () => {
      clearInterval(stageTimer);
      clearInterval(elapsedTimer);
    };
  }, []);

  return (
    <div className="sm-card preview-loader mb-6">
      <div className="preview-loader-bg" aria-hidden />
      <div className="preview-loader-content">
        <div className="preview-pipeline" aria-hidden>
          <Database label="Source" />
          <div className="preview-pipe">
            <span className="preview-dot preview-dot-1" />
            <span className="preview-dot preview-dot-2" />
            <span className="preview-dot preview-dot-3" />
          </div>
          <Database label="Destination" />
        </div>

        <div className="preview-stage" role="status" aria-live="polite">
          <span key={stageIdx} className="preview-stage-text">
            {STAGES[stageIdx]}
            <span className="preview-ellipsis">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          </span>
        </div>

        <div className="preview-elapsed">Elapsed {formatElapsed(elapsed)}</div>

        <div className="preview-pips">
          {STAGES.map((_, i) => (
            <span
              key={i}
              className={`preview-pip ${i === stageIdx ? "preview-pip-active" : ""}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Database({ label }: { label: string }) {
  return (
    <div className="preview-db">
      <span className="preview-db-ring" />
      <span className="preview-db-ring preview-db-ring-delayed" />
      <svg viewBox="0 0 40 50" className="preview-db-svg" aria-hidden>
        <ellipse cx="20" cy="7" rx="16" ry="5" />
        <path d="M4 7 V37 C4 40 11 43 20 43 C29 43 36 40 36 37 V7" fill="none" />
        <path d="M4 19 C4 22 11 25 20 25 C29 25 36 22 36 19" fill="none" />
        <path d="M4 29 C4 32 11 35 20 35 C29 35 36 32 36 29" fill="none" />
      </svg>
      <span className="preview-db-label">{label}</span>
    </div>
  );
}
