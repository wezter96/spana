import { CheckCircle, XCircle, Loader2, Circle, X, Trash2 } from "lucide-react";

export interface Attachment {
  name: string;
  contentType: string;
  url: string;
}

export interface FlowResult {
  name: string;
  platform: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: { message: string };
  attachments?: Attachment[];
  steps?: Array<{
    command: string;
    status: "passed" | "failed";
    durationMs: number;
    error?: string;
    attachments?: Attachment[];
  }>;
}

interface RunProgressProps {
  results: FlowResult[];
  isRunning: boolean;
  onSelectResult?: (result: FlowResult) => void;
  onRemoveResult?: (index: number) => void;
  onClearResults?: () => void;
  selectedResult?: FlowResult;
}

function StatusIcon({ status }: { status: FlowResult["status"] | "running" }) {
  switch (status) {
    case "passed":
      return <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
    case "running":
      return <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />;
    case "skipped":
      return <Circle className="w-4 h-4 text-zinc-500 shrink-0" />;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function RunProgress({
  results,
  isRunning,
  onSelectResult,
  onRemoveResult,
  onClearResults,
  selectedResult,
}: RunProgressProps) {
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-300">Results</h2>
        {(results.length > 0 || isRunning) && (
          <div className="flex items-center gap-3 text-xs">
            {isRunning && <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />}
            {passed > 0 && <span className="text-emerald-400">{passed} passed</span>}
            {failed > 0 && <span className="text-red-400">{failed} failed</span>}
            {skipped > 0 && <span className="text-zinc-500">{skipped} skipped</span>}
            {results.length > 0 && !isRunning && onClearResults && (
              <button
                onClick={onClearResults}
                className="text-zinc-500 hover:text-zinc-300 transition-colors ml-1"
                title="Clear all results"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {results.length === 0 && !isRunning && (
          <p className="text-sm text-zinc-500 px-2 py-4 text-center">No results yet</p>
        )}
        {results.length === 0 && isRunning && (
          <p className="text-sm text-zinc-500 px-2 py-4 text-center flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Running tests...
          </p>
        )}
        {results.map((result, i) => {
          const isSelected =
            selectedResult?.name === result.name && selectedResult?.platform === result.platform;
          return (
            <div
              key={`${result.name}-${result.platform}-${i}`}
              className={`group flex items-center gap-0.5 rounded transition-colors ${
                isSelected ? "bg-zinc-800 ring-1 ring-zinc-700" : "hover:bg-zinc-800/50"
              }`}
            >
              <button
                onClick={() => onSelectResult?.(result)}
                className="flex-1 flex items-center gap-2.5 px-2 py-1.5 text-left min-w-0"
              >
                <StatusIcon status={result.status} />
                <span className="text-sm text-zinc-200 truncate flex-1">{result.name}</span>
                <span className="text-xs text-zinc-500">{result.platform}</span>
                <span className="text-xs text-zinc-500 tabular-nums">
                  {formatDuration(result.durationMs)}
                </span>
              </button>
              {onRemoveResult && !isRunning && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveResult(i);
                  }}
                  className="opacity-0 group-hover:opacity-100 p-1 mr-1 text-zinc-600 hover:text-zinc-300 transition-all shrink-0"
                  title="Remove result"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
