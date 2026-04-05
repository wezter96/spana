import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/client";
import { DeviceSelector } from "@/components/device-selector";
import { DeviceScreenshot } from "@/components/device-screenshot";
import { ElementDetails } from "@/components/element-details";
import { ElementTree } from "@/components/element-tree";
import { RefreshCw, Radio } from "lucide-react";
import { elementsAtPoint, getElementByPath } from "@/lib/element-tree";

type Platform = "web" | "android" | "ios";

export function InspectorPage() {
  const [platform, setPlatform] = useState<Platform>("web");
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [liveMode, setLiveMode] = useState(false);
  const [selectedPath, setSelectedPath] = useState<number[] | undefined>(undefined);
  const [hoveredPath, setHoveredPath] = useState<number[] | undefined>(undefined);

  const inspectorInput = { platform, deviceId };

  const { data: screenshotData, refetch: refetchScreenshot } = useQuery(
    orpc.inspector.screenshot.queryOptions({
      input: inspectorInput,
      refetchInterval: liveMode ? 1000 : false,
    }),
  );

  const { data: hierarchyData, refetch: refetchHierarchy } = useQuery(
    orpc.inspector.hierarchy.queryOptions({
      input: inspectorInput,
      refetchInterval: liveMode ? 2000 : false,
    }),
  );

  const { data: selectorsData } = useQuery(
    orpc.inspector.selectors.queryOptions({
      input: inspectorInput,
      enabled: !!hierarchyData,
    }),
  );

  const root = hierarchyData;

  const selectedElement = root && selectedPath ? getElementByPath(root, selectedPath) : undefined;

  const hoveredElement = root && hoveredPath ? getElementByPath(root, hoveredPath) : undefined;

  // Build selectors for the selected element
  const elementSelectors = (() => {
    if (!selectedElement) return [];
    const selectors: { strategy: string; value: string }[] = [];
    if (selectedElement.resourceId) {
      selectors.push({ strategy: "resourceId", value: selectedElement.resourceId });
    }
    if (selectedElement.accessibilityLabel) {
      selectors.push({ strategy: "accessibility", value: selectedElement.accessibilityLabel });
    }
    if (selectedElement.text) {
      selectors.push({ strategy: "text", value: selectedElement.text });
    }
    // Include server-provided selectors if available
    if (selectorsData && Array.isArray(selectorsData)) {
      for (const s of selectorsData) {
        if (s && typeof s === "object" && "strategy" in s && "value" in s) {
          selectors.push(s as { strategy: string; value: string });
        }
      }
    }
    return selectors;
  })();

  const handleDeviceSelect = useCallback((p: Platform, id: string | undefined) => {
    setPlatform(p);
    setDeviceId(id);
    setSelectedPath(undefined);
    setHoveredPath(undefined);
  }, []);

  const handleClickPoint = useCallback(
    (x: number, y: number) => {
      if (!root) return;
      const matches = elementsAtPoint(root, x, y);
      if (matches.length > 0) {
        setSelectedPath(matches[0].path);
      }
    },
    [root],
  );

  const handleHoverPoint = useCallback(
    (x: number, y: number) => {
      if (!root) return;
      const matches = elementsAtPoint(root, x, y);
      if (matches.length > 0) {
        setHoveredPath(matches[0].path);
      } else {
        setHoveredPath(undefined);
      }
    },
    [root],
  );

  const handleHoverEnd = useCallback(() => {
    setHoveredPath(undefined);
  }, []);

  const handleTreeSelect = useCallback((path: number[]) => {
    setSelectedPath(path);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchScreenshot();
    refetchHierarchy();
  }, [refetchScreenshot, refetchHierarchy]);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-64px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-4 flex-wrap">
        <DeviceSelector platform={platform} deviceId={deviceId} onSelect={handleDeviceSelect} />

        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setLiveMode(!liveMode)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
              liveMode
                ? "bg-emerald-600/20 text-emerald-400 border border-emerald-600/40"
                : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200"
            }`}
          >
            <Radio className={`w-3.5 h-3.5 ${liveMode ? "animate-pulse" : ""}`} />
            Live
          </button>

          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded text-sm bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_350px] gap-4 flex-1 min-h-0">
        {/* Screenshot */}
        <div className="min-h-0 overflow-auto">
          <DeviceScreenshot
            image={screenshotData?.image}
            selectedBounds={selectedElement?.bounds}
            hoveredBounds={hoveredElement?.bounds}
            onClickPoint={handleClickPoint}
            onHoverPoint={handleHoverPoint}
            onHoverEnd={handleHoverEnd}
          />
        </div>

        {/* Element Details */}
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 min-h-0 overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800">
            <h2 className="text-sm font-semibold text-zinc-300">Element Details</h2>
          </div>
          <ElementDetails element={selectedElement} selectors={elementSelectors} />
        </div>
      </div>

      {/* Element Tree */}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 h-[250px] min-h-0 overflow-hidden">
        <ElementTree root={root} selectedPath={selectedPath} onSelect={handleTreeSelect} />
      </div>
    </div>
  );
}
