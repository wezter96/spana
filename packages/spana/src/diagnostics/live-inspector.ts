/**
 * Argent-inspired live diagnostics & profiling utilities:
 * 1. `NetworkEventBuffer` — live ring buffer of HTTP/GraphQL/Fetch requests with status/error/URL filtering.
 * 2. `buildComponentTreeScript()` — inspect live React Fiber, Vue 3, and custom Web Component trees.
 * 3. `buildPerformanceProfileScript()` — capture Web Vitals (LCP, CLS, FCP, TTFB), navigation timing,
 *    long tasks, resource breakdown, and V8 JS heap usage in a single evaluation.
 */

export interface LiveNetworkEvent {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  failed?: boolean;
  errorText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export interface NetworkEventFilter {
  urlIncludes?: string;
  method?: string;
  minStatus?: number;
  failedOnly?: boolean;
  limit?: number;
}

/**
 * Bounded in-memory ring buffer capturing live network requests from CDP (`Network.*`)
 * or Playwright (`request` / `response` / `requestfailed`) events.
 */
export class NetworkEventBuffer {
  private readonly maxEntries: number;
  private readonly events: LiveNetworkEvent[] = [];
  private readonly byId = new Map<string, LiveNetworkEvent>();

  constructor(maxEntries = 300) {
    this.maxEntries = Math.max(10, maxEntries);
  }

  recordRequest(input: {
    requestId: string;
    url: string;
    method: string;
    resourceType?: string;
    timestamp?: number;
    headers?: Record<string, string>;
  }): LiveNetworkEvent {
    const entry: LiveNetworkEvent = {
      requestId: input.requestId,
      url: input.url,
      method: input.method.toUpperCase(),
      resourceType: input.resourceType,
      startedAt: input.timestamp ?? Date.now(),
      ...(input.headers ? { requestHeaders: input.headers } : {}),
    };
    this.byId.set(input.requestId, entry);
    this.events.push(entry);
    if (this.events.length > this.maxEntries) {
      const evicted = this.events.shift();
      if (evicted) this.byId.delete(evicted.requestId);
    }
    return entry;
  }

  recordResponse(input: {
    requestId: string;
    status: number;
    statusText?: string;
    mimeType?: string;
    timestamp?: number;
    headers?: Record<string, string>;
    url?: string;
  }): LiveNetworkEvent | undefined {
    const existing = this.byId.get(input.requestId);
    const finishedAt = input.timestamp ?? Date.now();
    if (existing) {
      existing.status = input.status;
      existing.statusText = input.statusText;
      existing.mimeType = input.mimeType;
      existing.finishedAt = finishedAt;
      existing.durationMs = Math.max(0, finishedAt - existing.startedAt);
      if (input.headers) existing.responseHeaders = input.headers;
      return existing;
    }
    if (!input.url) return undefined;
    const synthetic = this.recordRequest({
      requestId: input.requestId,
      url: input.url,
      method: "GET",
      timestamp: finishedAt,
    });
    synthetic.status = input.status;
    synthetic.statusText = input.statusText;
    synthetic.mimeType = input.mimeType;
    synthetic.finishedAt = finishedAt;
    synthetic.durationMs = 0;
    if (input.headers) synthetic.responseHeaders = input.headers;
    return synthetic;
  }

  recordFailure(input: {
    requestId: string;
    errorText: string;
    timestamp?: number;
  }): LiveNetworkEvent | undefined {
    const existing = this.byId.get(input.requestId);
    if (!existing) return undefined;
    const finishedAt = input.timestamp ?? Date.now();
    existing.failed = true;
    existing.errorText = input.errorText;
    existing.finishedAt = finishedAt;
    existing.durationMs = Math.max(0, finishedAt - existing.startedAt);
    return existing;
  }

  query(filter: NetworkEventFilter = {}): LiveNetworkEvent[] {
    let result = this.events.filter((e) => {
      if (filter.urlIncludes && !e.url.toLowerCase().includes(filter.urlIncludes.toLowerCase())) {
        return false;
      }
      if (filter.method && e.method !== filter.method.toUpperCase()) {
        return false;
      }
      if (filter.failedOnly && !e.failed && (e.status === undefined || e.status < 400)) {
        return false;
      }
      if (
        filter.minStatus !== undefined &&
        (e.status === undefined || e.status < filter.minStatus)
      ) {
        return false;
      }
      return true;
    });
    if (filter.limit && filter.limit > 0 && result.length > filter.limit) {
      result = result.slice(-filter.limit);
    }
    return result.map((e) => ({ ...e }));
  }

  clear(): void {
    this.events.length = 0;
    this.byId.clear();
  }

  get size(): number {
    return this.events.length;
  }
}

export interface ComponentTreeNode {
  framework: "react" | "vue" | "web-component";
  name: string;
  testID?: string;
  props?: Record<string, unknown>;
  children: ComponentTreeNode[];
}

export interface ComponentTreeReport {
  detectedFrameworks: Array<"react" | "vue" | "web-component">;
  nodeCount: number;
  roots: ComponentTreeNode[];
}

/**
 * Build a self-contained browser JS snippet that extracts the live React Fiber, Vue 3,
 * and Custom Element component tree with sanitized prop previews (Argent-inspired).
 */
export function buildComponentTreeScript(opts?: { maxDepth?: number; maxNodes?: number }): string {
  const maxDepth = Math.max(1, opts?.maxDepth ?? 12);
  const maxNodes = Math.max(10, opts?.maxNodes ?? 200);
  return `(() => {
    const MAX_DEPTH = ${maxDepth};
    const MAX_NODES = ${maxNodes};
    let count = 0;
    const detected = new Set();

    function summarizeProps(obj) {
      if (!obj || typeof obj !== "object") return undefined;
      const out = {};
      let keys = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (k === "children" || k.startsWith("__")) continue;
        if (keys >= 8) break;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out[k] = typeof v === "string" && v.length > 60 ? v.slice(0, 57) + "..." : v;
          keys++;
        } else if (v === null) {
          out[k] = null;
          keys++;
        } else if (typeof v === "function") {
          out[k] = "[Function]";
          keys++;
        }
      }
      return keys > 0 ? out : undefined;
    }

    function walkReactFiber(fiber, depth) {
      const nodes = [];
      let cur = fiber;
      while (cur && count < MAX_NODES) {
        const type = cur.type;
        const isComponent = typeof type === "function" || (type && typeof type === "object");
        const name = typeof type === "function"
          ? (type.displayName || type.name || "Anonymous")
          : (type && typeof type === "object" ? (type.displayName || type.render?.name || "Component") : null);

        if (isComponent && name && depth < MAX_DEPTH) {
          count++;
          const props = cur.memoizedProps;
          const testID = props && (props["data-testid"] || props.testID || undefined);
          const children = cur.child ? walkReactFiber(cur.child, depth + 1) : [];
          nodes.push({
            framework: "react",
            name: String(name),
            ...(testID ? { testID: String(testID) } : {}),
            ...(summarizeProps(props) ? { props: summarizeProps(props) } : {}),
            children,
          });
        } else if (cur.child && depth < MAX_DEPTH) {
          nodes.push(...walkReactFiber(cur.child, depth));
        }
        cur = cur.sibling;
      }
      return nodes;
    }

    const roots = [];

    // 1. React 16-19 Fiber roots
    const allEls = [document.documentElement, document.body, ...Array.from(document.querySelectorAll("*")).slice(0, 250)].filter(Boolean);
    const seenFibers = new Set();
    for (const el of allEls) {
      const keys = Object.keys(el);
      const fiberKey = keys.find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$") || k.startsWith("__reactContainer$"));
      if (fiberKey) {
        detected.add("react");
        let rootFiber = el[fiberKey];
        if (rootFiber && rootFiber.stateNode && rootFiber.stateNode.current) {
          rootFiber = rootFiber.stateNode.current;
        }
        while (rootFiber && rootFiber.return) rootFiber = rootFiber.return;
        if (rootFiber && !seenFibers.has(rootFiber)) {
          seenFibers.add(rootFiber);
          roots.push(...walkReactFiber(rootFiber, 0));
        }
      }
      // 2. Vue 3 app root
      if (el.__vue_app__ && el.__vue_app__._container) {
        detected.add("vue");
        const vnode = el.__vue_app__._instance?.subTree;
        const walkVue = (node, depth) => {
          if (!node || count >= MAX_NODES || depth > MAX_DEPTH) return [];
          const name = node.type?.name || node.type?.__name;
          const children = [];
          if (Array.isArray(node.children)) {
            for (const c of node.children) children.push(...walkVue(c, depth + 1));
          } else if (node.component?.subTree) {
            children.push(...walkVue(node.component.subTree, depth + 1));
          }
          if (name) {
            count++;
            return [{
              framework: "vue",
              name: String(name),
              ...(summarizeProps(node.props) ? { props: summarizeProps(node.props) } : {}),
              children,
            }];
          }
          return children;
        };
        if (vnode) roots.push(...walkVue(vnode, 0));
      }
      // 3. Custom Web Components (hyphenated tag names)
      if (el.tagName && el.tagName.includes("-") && count < MAX_NODES) {
        detected.add("web-component");
        count++;
        roots.push({
          framework: "web-component",
          name: el.tagName.toLowerCase(),
          ...(el.getAttribute("data-testid") ? { testID: el.getAttribute("data-testid") } : {}),
          children: [],
        });
      }
    }

    return {
      detectedFrameworks: Array.from(detected),
      nodeCount: count,
      roots,
    };
  })()`;
}

export interface PerformanceProfileReport {
  url: string;
  timestamp: string;
  navigation?: {
    ttfbMs: number;
    domContentLoadedMs: number;
    loadEventMs: number;
    transferSizeBytes: number;
  };
  vitals: {
    fcpMs?: number;
    lcpMs?: number;
    cls?: number;
  };
  longTaskCount: number;
  longTaskTotalMs: number;
  resourceCount: number;
  slowestResources: Array<{
    name: string;
    initiatorType: string;
    durationMs: number;
    transferSize: number;
  }>;
  jsHeap?: {
    usedBytes: number;
    totalBytes: number;
    limitBytes: number;
  };
  domNodeCount: number;
}

/**
 * Build a self-contained browser JS snippet that collects Web Vitals (FCP/LCP/CLS),
 * Navigation Timing (TTFB/DCL/Load), Long Tasks, slowest resources, DOM size, and JS heap.
 */
export function buildPerformanceProfileScript(): string {
  return `(() => {
    const perf = window.performance;
    const navEntries = perf && perf.getEntriesByType ? perf.getEntriesByType("navigation") : [];
    const nav = navEntries && navEntries[0];
    const paintEntries = perf && perf.getEntriesByType ? perf.getEntriesByType("paint") : [];
    const fcpEntry = paintEntries.find((e) => e.name === "first-contentful-paint");
    const lcpEntries = perf && perf.getEntriesByType ? perf.getEntriesByType("largest-contentful-paint") : [];
    const lcpEntry = lcpEntries && lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1] : undefined;
    const layoutShifts = perf && perf.getEntriesByType ? perf.getEntriesByType("layout-shift") : [];
    let cls = 0;
    for (const ls of layoutShifts) {
      if (!ls.hadRecentInput && typeof ls.value === "number") cls += ls.value;
    }
    const longTasks = perf && perf.getEntriesByType ? perf.getEntriesByType("longtask") : [];
    let longTaskTotalMs = 0;
    for (const lt of longTasks) longTaskTotalMs += Number(lt.duration || 0);

    const resources = perf && perf.getEntriesByType ? perf.getEntriesByType("resource") : [];
    const slowestResources = resources
      .map((r) => ({
        name: String(r.name || "").slice(0, 140),
        initiatorType: String(r.initiatorType || "other"),
        durationMs: Math.round(Number(r.duration || 0)),
        transferSize: Number(r.transferSize || 0),
      }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10);

    const mem = perf && perf.memory ? {
      usedBytes: Number(perf.memory.usedJSHeapSize || 0),
      totalBytes: Number(perf.memory.totalJSHeapSize || 0),
      limitBytes: Number(perf.memory.jsHeapSizeLimit || 0),
    } : undefined;

    return {
      url: String(window.location.href || ""),
      timestamp: new Date().toISOString(),
      ...(nav ? {
        navigation: {
          ttfbMs: Math.round(Number(nav.responseStart || 0)),
          domContentLoadedMs: Math.round(Number(nav.domContentLoadedEventEnd || 0)),
          loadEventMs: Math.round(Number(nav.loadEventEnd || 0)),
          transferSizeBytes: Number(nav.transferSize || 0),
        },
      } : {}),
      vitals: {
        ...(fcpEntry ? { fcpMs: Math.round(Number(fcpEntry.startTime || 0)) } : {}),
        ...(lcpEntry ? { lcpMs: Math.round(Number(lcpEntry.startTime || 0)) } : {}),
        cls: Math.round(cls * 10000) / 10000,
      },
      longTaskCount: longTasks.length,
      longTaskTotalMs: Math.round(longTaskTotalMs),
      resourceCount: resources.length,
      slowestResources,
      ...(mem ? { jsHeap: mem } : {}),
      domNodeCount: document.querySelectorAll("*").length,
    };
  })()`;
}
