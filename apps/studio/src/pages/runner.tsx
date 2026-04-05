import { useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc, client } from "@/lib/client";
import { FlowList } from "@/components/flow-list";
import { RunProgress, type FlowResult } from "@/components/run-progress";
import { FailureDetails } from "@/components/failure-details";
import { Play, RotateCcw } from "lucide-react";

type Platform = "web" | "android" | "ios";

const ALL_PLATFORMS: Platform[] = ["web", "android", "ios"];

export function RunnerPage() {
  const [platforms, setPlatforms] = useState<Set<Platform>>(new Set(["web"]));
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [runId, setRunId] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [selectedResult, setSelectedResult] = useState<FlowResult | undefined>(undefined);

  // Discover flows
  const { data: flowsData } = useQuery(
    orpc.tests.listFlows.queryOptions({
      input: {},
    }),
  );

  const flows = flowsData?.flows ?? [];

  // Poll run status when we have an active run
  const { data: statusData } = useQuery(
    orpc.tests.status.queryOptions({
      input: { runId: runId! },
      enabled: !!runId,
      refetchInterval: runId ? 1000 : false,
    }),
  );

  const isRunning = !!runId && statusData?.status === "running";
  const results: FlowResult[] = (statusData?.results as FlowResult[]) ?? [];

  // Stop polling once completed
  const runCompleted = statusData?.status === "completed";

  // Auto-select all flows on first load
  useEffect(() => {
    if (flows.length > 0 && selectedFlows.size === 0) {
      setSelectedFlows(new Set(flows.map((f) => f.name)));
    }
  }, [flows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const togglePlatform = useCallback((p: Platform) => {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        if (next.size > 1) next.delete(p);
      } else {
        next.add(p);
      }
      return next;
    });
  }, []);

  const toggleFlow = useCallback((name: string) => {
    setSelectedFlows((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedFlows(new Set(flows.map((f) => f.name)));
  }, [flows]);

  const deselectAll = useCallback(() => {
    setSelectedFlows(new Set());
  }, []);

  const handleRun = useCallback(async () => {
    if (platforms.size === 0 || selectedFlows.size === 0) return;
    setIsStarting(true);
    setSelectedResult(undefined);
    try {
      // Build grep pattern from selected flow names
      const grep = [...selectedFlows].join("|");
      const result = await client.tests.run({
        platforms: [...platforms],
        grep,
      });
      setRunId(result.runId);
    } finally {
      setIsStarting(false);
    }
  }, [platforms, selectedFlows]);

  const handleRerunFailed = useCallback(async () => {
    const failedNames = results.filter((r) => r.status === "failed").map((r) => r.name);
    if (failedNames.length === 0 || platforms.size === 0) return;
    setIsStarting(true);
    setSelectedResult(undefined);
    try {
      const grep = failedNames.join("|");
      const result = await client.tests.run({
        platforms: [...platforms],
        grep,
      });
      setRunId(result.runId);
    } finally {
      setIsStarting(false);
    }
  }, [platforms, results]);

  const hasFailed = results.some((r) => r.status === "failed");

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-64px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-400">Platforms:</span>
          {ALL_PLATFORMS.map((p) => (
            <button
              key={p}
              onClick={() => togglePlatform(p)}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                platforms.has(p)
                  ? "bg-zinc-800 text-zinc-100 border border-zinc-600"
                  : "text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {hasFailed && runCompleted && (
            <button
              onClick={handleRerunFailed}
              disabled={isStarting || isRunning}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200 transition-colors disabled:opacity-40"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Re-run Failed
            </button>
          )}
          <button
            onClick={handleRun}
            disabled={isStarting || isRunning || selectedFlows.size === 0 || platforms.size === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            <Play className="w-3.5 h-3.5" />
            {isStarting ? "Starting..." : isRunning ? "Running..." : "Run"}
          </button>
        </div>
      </div>

      {/* 3-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[250px_1fr_300px] gap-4 flex-1 min-h-0">
        {/* Left: Flow list */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden">
          <FlowList
            flows={flows}
            selectedFlows={selectedFlows}
            onToggleFlow={toggleFlow}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
          />
        </div>

        {/* Center: Results */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden">
          <RunProgress
            results={results}
            isRunning={isRunning || isStarting}
            onSelectResult={setSelectedResult}
            selectedResult={selectedResult}
          />
        </div>

        {/* Right: Details */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden">
          <FailureDetails result={selectedResult} />
        </div>
      </div>
    </div>
  );
}
