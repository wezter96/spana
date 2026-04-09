import type { Platform, Selector } from "../schemas/selector.js";

export type ActionType =
  | "tap"
  | "doubleTap"
  | "longPress"
  | "inputText"
  | "scroll"
  | "swipe"
  | "pressKey"
  | "back"
  | "expect.toBeVisible"
  | "expect.toHaveText";

export interface RecordedAction {
  id: string;
  type: ActionType;
  selector?: Selector;
  selectorAlternatives: Selector[];
  params: Record<string, unknown>;
  timestamp: number;
  screenshotPath?: string;
}

export type RecordingStatus = "recording" | "stopped";

export interface RecordingSession {
  id: string;
  platform: Platform;
  status: RecordingStatus;
  actions: RecordedAction[];
}

export type NewActionInput = Omit<RecordedAction, "id">;

let _idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export function createRecordingSessionStore(): RecordingSessionStore {
  return new RecordingSessionStore();
}

export class RecordingSessionStore {
  private readonly sessions = new Map<string, RecordingSession>();

  start(platform: Platform): RecordingSession {
    const session: RecordingSession = {
      id: generateId("session"),
      platform,
      status: "recording",
      actions: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(sessionId: string): RecordingSession | undefined {
    return this.sessions.get(sessionId);
  }

  stop(sessionId: string): RecordingSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.status = "stopped";
    return session;
  }

  addAction(sessionId: string, input: NewActionInput): RecordedAction | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const action: RecordedAction = { id: generateId("action"), ...input };
    session.actions.push(action);
    return action;
  }

  deleteAction(sessionId: string, actionId: string): RecordingSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    session.actions = session.actions.filter((a) => a.id !== actionId);
    return session;
  }

  reorderActions(sessionId: string, orderedIds: string[]): RecordingSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const byId = new Map(session.actions.map((a) => [a.id, a]));
    session.actions = orderedIds.flatMap((id) => {
      const action = byId.get(id);
      return action ? [action] : [];
    });
    return session;
  }

  updateSelector(
    sessionId: string,
    actionId: string,
    selector: Selector,
  ): RecordingSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const action = session.actions.find((a) => a.id === actionId);
    if (!action) return undefined;
    action.selector = selector;
    return session;
  }
}
