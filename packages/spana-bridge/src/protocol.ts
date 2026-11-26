export type BridgeSelector =
  | string
  | { testID: string }
  | { text: string; systemUI?: boolean }
  | { accessibilityLabel: string; systemUI?: boolean }
  | { role: string; name?: string }
  | { point: { x: number; y: number } };

export interface BridgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BridgeElementMatch {
  id?: string;
  tag?: string;
  role?: string;
  text?: string;
  value?: string;
  accessibilityLabel?: string;
  rect: BridgeRect;
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  viewportWidth: number;
  viewportHeight: number;
  visible: boolean;
  enabled: boolean;
  clickable: boolean;
  focused?: boolean;
  attributes?: Record<string, string>;
  inShadowDom?: boolean;
  inIframe?: boolean;
}

export interface BridgeStorageEntries {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  cookies?: Array<{ name: string; value: string; path?: string; domain?: string }>;
  capacitorPreferences?: Record<string, string>;
}

export interface BridgeClearStorageOptions {
  localStorage?: boolean;
  sessionStorage?: boolean;
  cookies?: boolean;
  indexedDB?: boolean;
  capacitorPreferences?: boolean;
}

export interface BridgeSerializedMatcher {
  type: "string" | "regexp";
  pattern?: string;
  source?: string;
  flags?: string;
}

export interface BridgeMockResponse {
  status?: number;
  body?: string;
  json?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

export interface BridgeConsoleLog {
  type: string;
  text: string;
}

export interface BridgeJSError {
  name?: string;
  message: string;
  stack?: string;
}

export interface BridgeRequestMessage {
  id: number;
  method: string;
  params?: Record<string, any>;
}

export interface BridgeResponseMessage {
  id: number;
  result?: unknown;
  error?: string | { message: string };
}

export interface BridgeStorageAdapter {
  setPreferences?(entries: Record<string, string>): Promise<void> | void;
  clearPreferences?(): Promise<void> | void;
}
