import { useState, useCallback, useEffect } from "react";
import { ChevronRight, ChevronDown, Search } from "lucide-react";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ElementData {
  elementType?: string;
  resourceId?: string;
  text?: string;
  accessibilityLabel?: string;
  bounds: Bounds;
  enabled?: boolean;
  visible?: boolean;
  clickable?: boolean;
  focused?: boolean;
  id?: string;
  children?: readonly ElementData[];
}

interface ElementTreeProps {
  root: ElementData | undefined;
  selectedPath: number[] | undefined;
  onSelect: (path: number[]) => void;
}

function pathToKey(path: number[]): string {
  return path.join("-");
}

function matchesSearch(el: ElementData, query: string): boolean {
  const q = query.toLowerCase();
  return (
    !!el.text?.toLowerCase().includes(q) ||
    !!el.resourceId?.toLowerCase().includes(q) ||
    !!el.accessibilityLabel?.toLowerCase().includes(q) ||
    !!el.elementType?.toLowerCase().includes(q)
  );
}

function hasMatchingDescendant(el: ElementData, query: string): boolean {
  if (matchesSearch(el, query)) return true;
  return !!el.children?.some((child) => hasMatchingDescendant(child, query));
}

function getNodeLabel(el: ElementData): string {
  const type = el.elementType || "Element";
  const parts: string[] = [type];
  if (el.resourceId) parts.push(`#${el.resourceId}`);
  if (el.text) {
    const truncated = el.text.length > 30 ? el.text.slice(0, 30) + "..." : el.text;
    parts.push(`"${truncated}"`);
  }
  return parts.join(" ");
}

function TreeNode({
  element,
  path,
  depth,
  selectedPath,
  expandedPaths,
  toggleExpand,
  onSelect,
  searchQuery,
}: {
  element: ElementData;
  path: number[];
  depth: number;
  selectedPath: number[] | undefined;
  expandedPaths: Set<string>;
  toggleExpand: (key: string) => void;
  onSelect: (path: number[]) => void;
  searchQuery: string;
}) {
  const key = pathToKey(path);
  const isExpanded = expandedPaths.has(key);
  const hasChildren = !!element.children?.length;
  const isSelected = selectedPath && pathToKey(selectedPath) === key;
  const isSearchMatch = searchQuery && matchesSearch(element, searchQuery);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleExpand(key);
    },
    [toggleExpand, key],
  );

  const handleSelect = useCallback(() => {
    onSelect(path);
  }, [onSelect, path]);

  // If searching, hide non-matching branches
  if (searchQuery && !hasMatchingDescendant(element, searchQuery)) {
    return null;
  }

  return (
    <div>
      <div
        onClick={handleSelect}
        className={`flex items-center gap-1 py-0.5 px-1 rounded cursor-pointer text-xs font-mono hover:bg-zinc-800 ${
          isSelected ? "bg-zinc-700 text-blue-400" : "text-zinc-300"
        } ${isSearchMatch ? "ring-1 ring-amber-500/50" : ""}`}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        {hasChildren ? (
          <button onClick={handleToggle} className="p-0.5 hover:bg-zinc-700 rounded shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-zinc-500" />
            ) : (
              <ChevronRight className="w-3 h-3 text-zinc-500" />
            )}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span className="truncate">{getNodeLabel(element)}</span>
      </div>
      {isExpanded &&
        hasChildren &&
        element.children!.map((child, i) => (
          <TreeNode
            key={i}
            element={child}
            path={[...path, i]}
            depth={depth + 1}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
            onSelect={onSelect}
            searchQuery={searchQuery}
          />
        ))}
    </div>
  );
}

export function ElementTree({ root, selectedPath, onSelect }: ElementTreeProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));

  const toggleExpand = useCallback((key: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Auto-expand path to selected element
  useEffect(() => {
    if (!selectedPath) return;
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < selectedPath.length; i++) {
        next.add(pathToKey(selectedPath.slice(0, i)));
      }
      return next;
    });
  }, [selectedPath]);

  if (!root) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-500 text-sm p-4">
        No element hierarchy available
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2 border-b border-zinc-800">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Search elements..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded pl-7 pr-2 py-1 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        <TreeNode
          element={root}
          path={[]}
          depth={0}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          toggleExpand={toggleExpand}
          onSelect={onSelect}
          searchQuery={searchQuery}
        />
      </div>
    </div>
  );
}
