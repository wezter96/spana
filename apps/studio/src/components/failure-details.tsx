import { useState } from "react";
import { CheckCircle, XCircle, Image as ImageIcon } from "lucide-react";
import type { FlowResult, Attachment } from "./run-progress";

interface FailureDetailsProps {
  result: FlowResult | undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function ScreenshotList({ attachments, label }: { attachments: Attachment[]; label?: string }) {
  const images = attachments.filter((a) => a.contentType === "image/png");
  const [expanded, setExpanded] = useState<string | null>(null);

  if (images.length === 0) return null;

  return (
    <div>
      {label && <p className="text-xs font-medium text-zinc-400 mb-2">{label}</p>}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {images.map((img, i) => (
          <button
            key={i}
            onClick={() => setExpanded(expanded === img.url ? null : img.url)}
            className="shrink-0 rounded border border-zinc-700 hover:border-zinc-500 transition-colors overflow-hidden"
          >
            <img
              src={img.url}
              alt={img.name}
              loading="lazy"
              className="h-32 w-auto object-contain bg-zinc-900"
            />
            <div className="text-[10px] text-zinc-500 px-1 py-0.5 truncate max-w-[120px]">
              {img.name}
            </div>
          </button>
        ))}
      </div>
      {expanded && (
        <button
          type="button"
          className="mt-2 block w-full rounded border border-zinc-700 overflow-hidden cursor-pointer text-left"
          onClick={() => setExpanded(null)}
          aria-label="Collapse expanded screenshot"
        >
          <img src={expanded} alt="Expanded screenshot" className="w-full h-auto bg-zinc-900" />
        </button>
      )}
    </div>
  );
}

export function FailureDetails({ result }: FailureDetailsProps) {
  if (!result) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-zinc-500">Select a result to view details</p>
      </div>
    );
  }

  const statusColor =
    result.status === "passed"
      ? "text-emerald-400"
      : result.status === "failed"
        ? "text-red-400"
        : "text-zinc-500";

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-300">Details</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Header */}
        <div>
          <h3 className="text-sm font-medium text-zinc-200">{result.name}</h3>
          <div className="flex items-center gap-3 mt-1 text-xs">
            <span className="text-zinc-400">{result.platform}</span>
            <span className={statusColor}>{result.status}</span>
            <span className="text-zinc-500">{formatDuration(result.durationMs)}</span>
          </div>
        </div>

        {/* Error message */}
        {result.error && (
          <div className="rounded border border-red-900/50 bg-red-950/30 p-3">
            <p className="text-xs font-medium text-red-400 mb-1">Error</p>
            <pre className="text-xs text-red-300 whitespace-pre-wrap break-words font-mono">
              {result.error.message}
            </pre>
          </div>
        )}

        {/* Flow-level screenshots */}
        {result.attachments && result.attachments.length > 0 && (
          <ScreenshotList attachments={result.attachments} label="Screenshots" />
        )}

        {/* Steps breakdown */}
        {result.steps && result.steps.length > 0 && (
          <div>
            <p className="text-xs font-medium text-zinc-400 mb-2">Steps</p>
            <div className="space-y-1">
              {result.steps.map((step, i) => (
                <div key={i}>
                  <div className="flex items-start gap-2 px-2 py-1.5 rounded bg-zinc-800/40">
                    {step.status === "passed" ? (
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                    ) : (
                      <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-zinc-300 truncate">{step.command}</span>
                        {step.attachments && step.attachments.length > 0 && (
                          <ImageIcon className="w-3 h-3 text-zinc-500 shrink-0" />
                        )}
                        <span className="text-[10px] text-zinc-500 tabular-nums shrink-0">
                          {formatDuration(step.durationMs)}
                        </span>
                      </div>
                      {step.error && (
                        <p className="text-[11px] text-red-400 mt-0.5 break-words">{step.error}</p>
                      )}
                    </div>
                  </div>
                  {step.attachments && step.attachments.length > 0 && (
                    <div className="ml-6 mt-1 mb-2">
                      <ScreenshotList attachments={step.attachments} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
