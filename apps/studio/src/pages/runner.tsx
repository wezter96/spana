import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc, client } from "@/lib/client";
import { FlowList } from "@/components/flow-list";
import { RunProgress, type FlowResult } from "@/components/run-progress";
import { DeviceSelector } from "../components/device-selector.js";
import { Play, RotateCcw } from "lucide-react";

type Platform = "web" | "android" | "ios";

const ALL_PLATFORMS: Platform[] = ["web", "android", "ios"];

const SESSION_KEY = "spana-studio-runner";

function loadSession(): { runId: string | null; results: FlowResult[]; platforms: Platform[] } {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return { runId: null, results: [], platforms: ["web"] };
    return JSON.parse(raw);
  } catch {
    return { runId: null, results: [], platforms: ["web"] };
  }
}

function saveSession(data: { runId: string | null; results: FlowResult[]; platforms: Platform[] }) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
  } catch {
    // storage full or unavailable
  }
}

export function RunnerPage() {
  const session = useRef(loadSession());
  const [platforms, setPlatforms] = useState<Set<Platform>>(new Set(session.current.platforms));
  const [selectedFlows, setSelectedFlows] = useState<Set<string>>(new Set());
  const [runId, setRunId] = useState<string | null>(session.current.runId);
  const [isStarting, setIsStarting] = useState(false);
  const [selectedResult, setSelectedResult] = useState<FlowResult | undefined>(undefined);
  const [cachedResults, setCachedResults] = useState<FlowResult[]>(session.current.results);
  const [captureScreenshots, setCaptureScreenshots] = useState(false);
  const [captureSteps, setCaptureSteps] = useState(false);
  const [deviceIds, setDeviceIds] = useState<Record<Platform, string | undefined>>(() => {
    const initial: Record<Platform, string | undefined> = {
      web: undefined,
      android: undefined,
      ios: undefined,
    };
    return initial;
  });

  // Discover flows
  console.log("[runner] Starting flow query...");
  const {
    data: flowsData,
    error: flowsError,
    isLoading,
  } = useQuery(
    orpc.tests.listFlows.queryOptions({
      input: {},
      onError: (err: unknown) => {
        console.error("[runner] Failed to fetch flows:", err);
      },
    }),
  );
  console.log("[runner] Query state:", { isLoading, hasData: !!flowsData, hasError: !!flowsError });
  if (flowsError) {
    console.error("[runner] Flow error:", flowsError);
  }

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
  const liveResults: FlowResult[] = (statusData?.results as FlowResult[]) ?? [];
  const runCompleted = statusData?.status === "completed";

  // Use live results when available, fall back to cached
  const results = liveResults.length > 0 ? liveResults : cachedResults;

  // Persist results to sessionStorage when run completes
  useEffect(() => {
    if (runCompleted && liveResults.length > 0) {
      setCachedResults(liveResults);
      saveSession({ runId, results: liveResults, platforms: [...platforms] });
    }
  }, [runCompleted, liveResults.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select all flows on first load
  useEffect(() => {
    if (flows.length > 0 && selectedFlows.size === 0) {
      setSelectedFlows(new Set(flows.map((f) => f.name)));
    }
  }, [flows.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDeviceSelect = useCallback((platform: Platform, id: string | undefined) => {
    setDeviceIds((prev) => ({ ...prev, [platform]: id }));
  }, []);

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
    setCachedResults([]);
    try {
      const allSelected = selectedFlows.size === flows.length;
      const devices = [...platforms]
        .map((p) => ({ platform: p, deviceId: deviceIds[p] }))
        .filter((d) => d.deviceId);
      const result = await client.tests.run({
        platforms: [...platforms],
        grep: allSelected ? undefined : [...selectedFlows][0],
        captureScreenshots: captureScreenshots || undefined,
        captureSteps: captureSteps || undefined,
        devices: devices.length > 0 ? devices : undefined,
      });
      setRunId(result.runId);
      saveSession({ runId: result.runId, results: [], platforms: [...platforms] });
    } finally {
      setIsStarting(false);
    }
  }, [platforms, selectedFlows, flows.length]);

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

  const handleRemoveResult = useCallback(
    (index: number) => {
      const updated = results.filter((_, i) => i !== index);
      setCachedResults(updated);
      saveSession({ runId, results: updated, platforms: [...platforms] });
      if (selectedResult && results[index] === selectedResult) {
        setSelectedResult(undefined);
      }
    },
    [results, runId, platforms, selectedResult],
  );

  const handleClearResults = useCallback(() => {
    setCachedResults([]);
    setRunId(null);
    setSelectedResult(undefined);
    saveSession({ runId: null, results: [], platforms: [...platforms] });
  }, [platforms]);

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

        <div className="flex items-center gap-3 border-l border-zinc-800 pl-4 ml-2">
          {[...platforms].map((p) => (
            <DeviceSelector
              key={p}
              platform={p}
              deviceId={deviceIds[p]}
              onSelect={handleDeviceSelect}
            />
          ))}
        </div>

        <div className="flex items-center gap-3 border-l border-zinc-800 pl-4 ml-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={captureScreenshots}
              onChange={(e) => setCaptureScreenshots(e.target.checked)}
              className="rounded border-zinc-600"
            />
            Screenshots
          </label>
          <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={captureSteps}
              onChange={(e) => setCaptureSteps(e.target.checked)}
              className="rounded border-zinc-600"
            />
            Step captures
          </label>
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

      {/* 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 flex-1 min-h-0">
        {/* Left: Flow list */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden lg:col-span-1">
          <FlowList
            flows={flows}
            selectedFlows={selectedFlows}
            onToggleFlow={toggleFlow}
            onSelectAll={selectAll}
            onDeselectAll={deselectAll}
          />
        </div>

        {/* Right: Results with expandable details */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden lg:col-span-3">
          <RunProgress
            results={results}
            isRunning={isRunning || isStarting}
            onSelectResult={setSelectedResult}
            onRemoveResult={handleRemoveResult}
            onClearResults={handleClearResults}
            selectedResult={selectedResult}
          />
        </div>
      </div>
    </div>
  );
}
