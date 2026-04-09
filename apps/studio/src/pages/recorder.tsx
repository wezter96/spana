import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc, client } from "@/lib/client";
import { elementsAtPoint } from "@/lib/element-tree";
import { Square, Circle, Trash2, Copy } from "lucide-react";

type Platform = "web" | "android" | "ios";
type RecorderState = "idle" | "recording" | "stopped";

type ActionType =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "inputText"
  | "expect.toBeVisible"
  | "scroll"
  | "swipe"
  | "back";

interface RecordedAction {
  id: string;
  type: ActionType;
  selector?: string;
  params?: Record<string, unknown>;
  timestamp: number;
}

interface ActionPickerProps {
  x: number;
  y: number;
  onPick: (actionType: ActionType) => void;
  onDismiss: () => void;
}

function ActionPicker({ x, y, onPick, onDismiss }: ActionPickerProps) {
  const actions: ActionType[] = [
    "tap",
    "doubleTap",
    "longPress",
    "inputText",
    "expect.toBeVisible",
  ];

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={onDismiss} />
      <div
        style={{
          position: "fixed",
          left: Math.min(x, window.innerWidth - 200),
          top: Math.min(y, window.innerHeight - 200),
          zIndex: 50,
          background: "#1a1a1a",
          border: "1px solid #333",
          borderRadius: 8,
          padding: "4px",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 160,
          boxShadow: "0 4px 24px rgba(0,0,0,0.5)",
        }}
      >
        {actions.map((a) => (
          <button
            key={a}
            onClick={() => onPick(a)}
            style={{
              background: "transparent",
              border: "none",
              color: "#e5e5e5",
              padding: "6px 12px",
              borderRadius: 4,
              textAlign: "left",
              cursor: "pointer",
              fontSize: 13,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "#262626";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            {a}
          </button>
        ))}
      </div>
    </>
  );
}

export function RecorderPage() {
  const [platform, setPlatform] = useState<Platform>("android");
  const [state, setState] = useState<RecorderState>("idle");
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [actions, setActions] = useState<RecordedAction[]>([]);
  const [flowName, setFlowName] = useState("");
  const [generatedCode, setGeneratedCode] = useState("");
  const [savedFilePath, setSavedFilePath] = useState<string | undefined>(undefined);
  const [watchMode, setWatchMode] = useState(false);
  const [watchPrompt, setWatchPrompt] = useState(false);
  const hierarchyHashRef = useRef<string>("");

  // Action picker state
  const [pickerPos, setPickerPos] = useState<{
    screenX: number;
    screenY: number;
    deviceX: number;
    deviceY: number;
  } | null>(null);

  // Screenshot polling during recording
  const { data: screenshotData } = useQuery(
    orpc.inspector.screenshot.queryOptions({
      input: { platform },
      refetchInterval: state === "recording" ? 1000 : false,
      enabled: state === "recording",
    }),
  );

  // Hierarchy for element picking
  const { data: hierarchyData } = useQuery(
    orpc.inspector.hierarchy.queryOptions({
      input: { platform },
      enabled: state === "recording",
    }),
  );

  // Selectors query
  useQuery(
    orpc.inspector.selectors.queryOptions({
      input: { platform },
      enabled: state === "recording" && !!hierarchyData,
    }),
  );

  // Watch mode: poll hierarchy every 1.5s
  useEffect(() => {
    if (!watchMode || state !== "recording") return;

    const interval = setInterval(async () => {
      try {
        const result = await client.inspector.hierarchy({ platform });
        const hash =
          JSON.stringify(result).length.toString() + JSON.stringify(result).slice(0, 100);
        if (hierarchyHashRef.current && hash !== hierarchyHashRef.current) {
          setWatchPrompt(true);
        }
        hierarchyHashRef.current = hash;
      } catch {
        // ignore
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [watchMode, state, platform]);

  // Task 7: Auto-generate code when actions change
  useEffect(() => {
    if (!sessionId || actions.length === 0) {
      setGeneratedCode("");
      return;
    }
    client.recording
      .generateCode({ sessionId, flowName: flowName || "Recorded flow" })
      .then((data) => setGeneratedCode(data.code))
      .catch(() => {});
  }, [sessionId, actions, flowName]);

  const handleStart = useCallback(async () => {
    try {
      const result = await client.recording.start({ platform });
      setSessionId(result.sessionId);
      setActions([]);
      setGeneratedCode("");
      setSavedFilePath(undefined);
      setState("recording");
      hierarchyHashRef.current = "";
    } catch (err) {
      console.error("Failed to start recording:", err);
    }
  }, [platform]);

  const handleStop = useCallback(async () => {
    if (!sessionId) return;
    try {
      await client.recording.stop({ sessionId });
      setState("stopped");
    } catch (err) {
      console.error("Failed to stop recording:", err);
    }
  }, [sessionId]);

  const handleDeleteAction = useCallback(
    async (actionId: string) => {
      if (!sessionId) return;
      try {
        await client.recording.deleteAction({ sessionId, actionId });
        setActions((prev) => prev.filter((a) => a.id !== actionId));
      } catch (err) {
        console.error("Failed to delete action:", err);
      }
    },
    [sessionId],
  );

  const handleGenerate = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await client.recording.generateCode({
        sessionId,
        flowName: flowName || "Recorded flow",
      });
      setGeneratedCode(result.code);
    } catch (err) {
      console.error("Failed to generate code:", err);
    }
  }, [sessionId, flowName]);

  const handleSave = useCallback(async () => {
    if (!sessionId) return;
    try {
      const result = await client.recording.save({
        sessionId,
        flowName: flowName || "Recorded flow",
      });
      setGeneratedCode(result.code);
      setSavedFilePath(result.filePath);
    } catch (err) {
      console.error("Failed to save:", err);
    }
  }, [sessionId, flowName]);

  const handleNew = useCallback(() => {
    setSessionId(undefined);
    setActions([]);
    setGeneratedCode("");
    setSavedFilePath(undefined);
    setFlowName("");
    setState("idle");
    hierarchyHashRef.current = "";
    setWatchPrompt(false);
  }, []);

  const refreshSession = useCallback(async () => {
    if (!sessionId) return;
    try {
      const session = await client.recording.getSession({ sessionId });
      if (session && Array.isArray((session as any).actions)) {
        setActions((session as any).actions as RecordedAction[]);
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

  const handleActionPick = useCallback(
    async (actionType: ActionType, point: { x: number; y: number }) => {
      if (!sessionId) return;
      setPickerPos(null);

      const root = hierarchyData;
      let selector: string | undefined;
      if (root) {
        const matches = elementsAtPoint(root as any, point.x, point.y);
        if (matches.length > 0) {
          const el = matches[0].element as any;
          selector = el.resourceId || el.accessibilityLabel || el.text || undefined;
        }
      }

      try {
        const execResult = await client.recording.executeAction({
          sessionId,
          platform,
          actionType,
          selector,
          params: { x: point.x, y: point.y },
        });
        // selectorAlternatives available in execResult if needed
        void execResult;
      } catch {
        // non-fatal
      }

      try {
        await client.recording.addAction({
          sessionId,
          action: {
            type: actionType,
            selector,
            params: { x: point.x, y: point.y },
          } as any,
        });
        await refreshSession();
      } catch (err) {
        console.error("Failed to add action:", err);
      }
    },
    [sessionId, hierarchyData, platform, refreshSession],
  );

  const handleWatchActionPick = useCallback(
    async (actionType: ActionType) => {
      if (!sessionId) return;
      setWatchPrompt(false);
      try {
        await client.recording.addAction({
          sessionId,
          action: { type: actionType } as any,
        });
        await refreshSession();
      } catch {
        // ignore
      }
    },
    [sessionId, refreshSession],
  );

  const handleCopyCode = useCallback(() => {
    if (generatedCode) {
      navigator.clipboard.writeText(generatedCode).catch(() => {});
    }
  }, [generatedCode]);

  // Wrap DeviceScreenshot click to capture screen coords
  const screenshotContainerRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-64px)]">
      {/* Top controls */}
      <div className="flex items-center gap-3 flex-wrap">
        {state === "idle" && (
          <>
            <label className="text-xs text-zinc-400">Platform:</label>
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value as Platform)}
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded px-2 py-1.5 text-sm"
            >
              <option value="web">web</option>
              <option value="android">android</option>
              <option value="ios">ios</option>
            </select>
            <button
              onClick={handleStart}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded text-sm bg-red-600 text-white hover:bg-red-500 transition-colors"
            >
              <Circle className="w-3.5 h-3.5 fill-white" />
              Start Recording
            </button>
          </>
        )}

        {state === "recording" && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-sm text-red-400 font-medium">Recording</span>
            </div>
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-pointer select-none ml-2">
              <input
                type="checkbox"
                checked={watchMode}
                onChange={(e) => setWatchMode(e.target.checked)}
                className="rounded border-zinc-600"
              />
              Watch mode
            </label>
            <button
              onClick={handleStop}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded text-sm bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors ml-auto"
            >
              <Square className="w-3.5 h-3.5 fill-zinc-200" />
              Stop
            </button>
          </>
        )}

        {state === "stopped" && (
          <>
            <input
              type="text"
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              placeholder="Flow name..."
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 rounded px-3 py-1.5 text-sm w-48 placeholder-zinc-500"
            />
            <button
              onClick={handleGenerate}
              className="px-3 py-1.5 rounded text-sm bg-zinc-700 text-zinc-200 hover:bg-zinc-600 transition-colors"
            >
              Generate
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 rounded text-sm bg-emerald-600 text-white hover:bg-emerald-500 transition-colors"
            >
              Save
            </button>
            <button
              onClick={handleNew}
              className="px-3 py-1.5 rounded text-sm bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200 transition-colors ml-auto"
            >
              New
            </button>
          </>
        )}
      </div>

      {/* Watch mode prompt bar */}
      {watchPrompt && state === "recording" && (
        <div
          style={{
            background: "#1a1a1a",
            border: "1px solid #333",
            borderRadius: 8,
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ color: "#e5e5e5", fontSize: 13 }}>
            Screen changed — what did you just do?
          </span>
          {(["tap", "inputText", "scroll", "swipe", "back"] as ActionType[]).map((a) => (
            <button
              key={a}
              onClick={() => handleWatchActionPick(a)}
              style={{
                background: "#262626",
                border: "1px solid #333",
                color: "#e5e5e5",
                padding: "4px 10px",
                borderRadius: 4,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {a}
            </button>
          ))}
          <button
            onClick={() => setWatchPrompt(false)}
            style={{
              background: "transparent",
              border: "none",
              color: "#666",
              fontSize: 12,
              cursor: "pointer",
              marginLeft: "auto",
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Save success */}
      {savedFilePath && (
        <div
          style={{
            background: "#0f2a1a",
            border: "1px solid #1a4a2a",
            borderRadius: 6,
            padding: "8px 14px",
            fontSize: 13,
            color: "#4ade80",
          }}
        >
          Saved to: <span style={{ fontFamily: "monospace" }}>{savedFilePath}</span>
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* Left panel: screenshot (during recording) or action timeline */}
        <div className="flex flex-col gap-3 min-h-0">
          {state === "recording" && screenshotData?.image ? (
            <div
              ref={screenshotContainerRef}
              className="min-h-0 overflow-auto"
              // We intercept clicks at the container level to capture screen coords
              onClick={() => {
                // DeviceScreenshot handles click internally, so we use onClickPoint override
              }}
            >
              <ScreenshotWithPicker
                image={screenshotData.image}
                onActionPick={handleActionPick}
                hierarchyData={hierarchyData}
                state={state}
              />
            </div>
          ) : (
            <ActionTimeline actions={actions} onDelete={handleDeleteAction} state={state} />
          )}

          {/* During recording, show timeline below screenshot */}
          {state === "recording" && (
            <ActionTimeline actions={actions} onDelete={handleDeleteAction} state={state} compact />
          )}
        </div>

        {/* Right panel: code preview */}
        <div
          style={{
            background: "#0a0a0a",
            border: "1px solid #262626",
            borderRadius: 8,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "8px 14px",
              borderBottom: "1px solid #262626",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: "#a1a1aa" }}>Code Preview</span>
            {generatedCode && (
              <button
                onClick={handleCopyCode}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#71717a",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                }}
              >
                <Copy className="w-3.5 h-3.5" />
                Copy
              </button>
            )}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            {generatedCode ? (
              <pre
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  color: "#e5e5e5",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                }}
              >
                {generatedCode}
              </pre>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  color: "#52525b",
                  fontSize: 13,
                }}
              >
                {state === "idle"
                  ? "Start recording to generate code"
                  : state === "recording"
                    ? "Code will appear here as you record actions"
                    : "Click Generate or Save to produce code"}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action picker overlay */}
      {pickerPos && (
        <ActionPicker
          x={pickerPos.screenX}
          y={pickerPos.screenY}
          onPick={handleActionPick}
          onDismiss={() => setPickerPos(null)}
        />
      )}
    </div>
  );
}

// ---- Sub-components ----

interface ScreenshotWithPickerProps {
  image: string;
  onActionPick: (actionType: ActionType, point: { x: number; y: number }) => void;
  hierarchyData: unknown;
  state: RecorderState;
}

function ScreenshotWithPicker({
  image,
  onActionPick,
  hierarchyData: _hierarchyData,
  state,
}: ScreenshotWithPickerProps) {
  const [pickerPos, setPickerPos] = useState<{
    screenX: number;
    screenY: number;
    deviceX: number;
    deviceY: number;
  } | null>(null);
  const [pendingPoint, setPendingPoint] = useState<{ x: number; y: number } | null>(null);

  const handlePick = useCallback(
    (actionType: ActionType) => {
      setPickerPos(null);
      if (pendingPoint) {
        onActionPick(actionType, pendingPoint);
      }
    },
    [pendingPoint, onActionPick],
  );

  // We wrap DeviceScreenshot in a div that intercepts mouse clicks for screen coords
  return (
    <div
      style={{ position: "relative", display: "inline-block" }}
      onClickCapture={() => {
        if (state !== "recording") return;
        // Will be set by DeviceScreenshot's click
        setPendingPoint(null); // reset
      }}
    >
      <ClickableScreenshot
        image={image}
        onClickWithCoords={(screenX, screenY, deviceX, deviceY) => {
          if (state !== "recording") return;
          setPendingPoint({ x: deviceX, y: deviceY });
          setPickerPos({ screenX, screenY, deviceX, deviceY });
        }}
      />
      {pickerPos && (
        <ActionPicker
          x={pickerPos.screenX}
          y={pickerPos.screenY}
          onPick={handlePick}
          onDismiss={() => setPickerPos(null)}
        />
      )}
    </div>
  );
}

interface ClickableScreenshotProps {
  image: string;
  onClickWithCoords: (screenX: number, screenY: number, deviceX: number, deviceY: number) => void;
}

function ClickableScreenshot({ image, onClickWithCoords }: ClickableScreenshotProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const scaleX = img.naturalWidth / rect.width;
      const scaleY = img.naturalHeight / rect.height;
      const deviceX = (e.clientX - rect.left) * scaleX;
      const deviceY = (e.clientY - rect.top) * scaleY;
      onClickWithCoords(e.clientX, e.clientY, deviceX, deviceY);
    },
    [onClickWithCoords],
  );

  return (
    <div
      style={{
        background: "#111",
        borderRadius: 8,
        border: "1px solid #262626",
        overflow: "hidden",
        display: "inline-block",
      }}
    >
      <img
        ref={imgRef}
        src={`data:image/png;base64,${image}`}
        alt="Device screenshot"
        style={{
          maxWidth: "100%",
          maxHeight: 500,
          objectFit: "contain",
          cursor: "crosshair",
          display: "block",
        }}
        onClick={handleClick}
        draggable={false}
      />
    </div>
  );
}

interface ActionTimelineProps {
  actions: RecordedAction[];
  onDelete: (id: string) => void;
  state: RecorderState;
  compact?: boolean;
}

function ActionTimeline({ actions, onDelete, state, compact }: ActionTimelineProps) {
  return (
    <div
      style={{
        background: "#0a0a0a",
        border: "1px solid #262626",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        minHeight: compact ? 120 : 0,
        flex: compact ? "0 0 auto" : 1,
        overflow: "hidden",
        maxHeight: compact ? 180 : undefined,
      }}
    >
      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid #262626",
          fontSize: 13,
          fontWeight: 600,
          color: "#a1a1aa",
          flexShrink: 0,
        }}
      >
        Action Timeline
        {actions.length > 0 && (
          <span style={{ marginLeft: 8, fontSize: 11, color: "#52525b", fontWeight: 400 }}>
            {actions.length} action{actions.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
        {actions.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              minHeight: 60,
              color: "#52525b",
              fontSize: 13,
            }}
          >
            {state === "recording" ? "Click elements to record actions" : "No actions recorded"}
          </div>
        ) : (
          actions.map((action, i) => (
            <div
              key={action.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 14px",
                borderBottom: "1px solid #1a1a1a",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "#111";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "#262626",
                  color: "#71717a",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, color: "#e5e5e5", fontWeight: 500 }}>
                  {action.type}
                </span>
                {action.selector && (
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 11,
                      color: "#71717a",
                      fontFamily: "monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 200,
                      display: "inline-block",
                      verticalAlign: "middle",
                    }}
                  >
                    {action.selector}
                  </span>
                )}
              </div>
              <button
                onClick={() => onDelete(action.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#52525b",
                  cursor: "pointer",
                  padding: 4,
                  borderRadius: 4,
                  display: "flex",
                  alignItems: "center",
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "#ef4444";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.color = "#52525b";
                }}
              >
                <Trash2 style={{ width: 14, height: 14 }} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
