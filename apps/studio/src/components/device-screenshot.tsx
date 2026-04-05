import { useRef, useCallback } from "react";
import { MonitorOff } from "lucide-react";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DeviceScreenshotProps {
  image: string | undefined;
  selectedBounds: Bounds | undefined;
  hoveredBounds: Bounds | undefined;
  onClickPoint: (x: number, y: number) => void;
  onHoverPoint: (x: number, y: number) => void;
  onHoverEnd: () => void;
}

const boundsEqual = (a?: Bounds, b?: Bounds) =>
  a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export function DeviceScreenshot({
  image,
  selectedBounds,
  hoveredBounds,
  onClickPoint,
  onHoverPoint,
  onHoverEnd,
}: DeviceScreenshotProps) {
  const imgRef = useRef<HTMLImageElement>(null);

  const toDeviceCoords = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    return { x, y };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const coords = toDeviceCoords(e);
      if (coords) onClickPoint(coords.x, coords.y);
    },
    [toDeviceCoords, onClickPoint],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const coords = toDeviceCoords(e);
      if (coords) onHoverPoint(coords.x, coords.y);
    },
    [toDeviceCoords, onHoverPoint],
  );

  const boundsToStyle = useCallback((bounds: Bounds): React.CSSProperties | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    const scaleX = rect.width / img.naturalWidth;
    const scaleY = rect.height / img.naturalHeight;
    return {
      position: "absolute",
      left: bounds.x * scaleX,
      top: bounds.y * scaleY,
      width: bounds.width * scaleX,
      height: bounds.height * scaleY,
      pointerEvents: "none",
    };
  }, []);

  if (!image) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[400px] bg-zinc-900 rounded-lg border border-zinc-800 text-zinc-500">
        <MonitorOff className="w-12 h-12 mb-3" />
        <p className="text-sm">No screenshot available</p>
        <p className="text-xs mt-1">Select a device and connect to start inspecting</p>
      </div>
    );
  }

  return (
    <div className="relative inline-block bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
      <img
        ref={imgRef}
        src={`data:image/png;base64,${image}`}
        alt="Device screenshot"
        className="max-w-full max-h-[600px] object-contain cursor-crosshair"
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={onHoverEnd}
        draggable={false}
      />
      {selectedBounds &&
        (() => {
          const style = boundsToStyle(selectedBounds);
          return style ? (
            <div style={style} className="border-2 border-blue-500 bg-blue-500/15 rounded-sm" />
          ) : null;
        })()}
      {hoveredBounds &&
        !boundsEqual(hoveredBounds, selectedBounds) &&
        (() => {
          const style = boundsToStyle(hoveredBounds);
          return style ? (
            <div style={style} className="border border-orange-400 bg-orange-400/10 rounded-sm" />
          ) : null;
        })()}
    </div>
  );
}
