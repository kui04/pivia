import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    parseEntriesVersion,
    parseSessionId,
    parseSyncEpoch,
    parseSyncSeq,
    SESSION_CLOSE_CODE,
    type EntriesVersion,
    type SessionDelta,
    type SessionDetailResponse,
    type SessionId,
    type SessionStateSnapshot,
    type SessionSummary,
    type SessionWsServerMessage,
    type SyncEpoch,
    type SyncSeq,
} from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";

import type { WebSocketConstructor, WebSocketLike } from "@/lib/transport/websocket";
import { createSessionStore } from "@/stores/session/store";

import { WorkspacePage } from "./WorkspacePage";
import styles from "./WorkspacePage.stories.module.css";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid story session id: ${raw}`);
    }
    return parsed;
}

function ev(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw new Error(`Invalid story entries version: ${raw}`);
    }
    return parsed;
}

function runtimeId(raw: string): SyncEpoch<"session"> {
    const parsed = parseSyncEpoch<"session">(raw);
    if (parsed === null) {
        throw new Error(`Invalid story runtime id: ${raw}`);
    }
    return parsed;
}

function seq(raw: number): SyncSeq<"session"> {
    const parsed = parseSyncSeq<"session">(raw);
    if (parsed === null) {
        throw new Error(`Invalid story session seq: ${raw}`);
    }
    return parsed;
}

const SESSION_ID = sid("session-1");
const ENTRIES_VERSION = ev("3:1.5.2");
const RUNTIME = runtimeId("story-runtime-1");
const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function summary(): SessionSummary {
    return {
        id: SESSION_ID,
        cwd: "/home/u/pivia",
        name: "First task",
        firstMessage: "Show the transcript view.",
        messageCount: 4,
        createdAtMs: 1_000,
        modifiedAtMs: 5_000,
        hasParent: false,
        runtimeState: "idle",
        attachedClients: 1,
    };
}

function sessionState(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: SESSION_ID,
        cwd: "/home/u/pivia",
        name: "First task",
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 4,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

function userEntry(id: string, parentId: string | null, text: string, timestamp: number): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: new Date(timestamp).toISOString(),
        message: { role: "user", content: text, timestamp },
    };
}

function assistantEntry(
    id: string,
    parentId: string | null,
    content: AssistantMessage["content"],
    overrides: Partial<AssistantMessage> = {},
): FileEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: "2026-04-01T00:00:02.000Z",
        message: {
            role: "assistant",
            content,
            api: "test",
            provider: "test",
            model: "test",
            usage: EMPTY_USAGE,
            stopReason: "stop",
            timestamp: 2_000,
            ...overrides,
        },
    };
}

const TRANSCRIPT_ENTRIES: readonly FileEntry[] = [
    userEntry("m1", null, "Show the transcript view for this session.", 1_000),
    assistantEntry(
        "m2",
        "m1",
        [
            { type: "thinking", thinking: "Read the page, then render the transcript." },
            {
                type: "toolCall",
                id: "call-1",
                name: "read",
                arguments: { path: "src/pages/Workspace/WorkspacePage.tsx" },
            },
        ],
        { timestamp: 1_500, stopReason: "toolUse" },
    ),
    {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-04-01T00:00:02.500Z",
        message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [{ type: "text", text: "export function WorkspacePage() {}" }],
            isError: false,
            timestamp: 2_500,
        },
    },
    assistantEntry("m4", "m3", [{ type: "text", text: "The transcript view is connected to the session store." }], {
        timestamp: 3_000,
        durationMs: 2_000,
    }),
];

function inlineSnapshot(
    entries: readonly FileEntry[],
    overrides: Partial<SessionStateSnapshot> = {},
): SessionWsServerMessage {
    return {
        type: "sync:snapshot",
        cursor: { epoch: RUNTIME, seq: seq(1) },
        snapshot: {
            entriesVersion: ENTRIES_VERSION,
            baseEntryCount: 0,
            entries: { mode: "inline", data: [...entries] },
            state: sessionState(overrides),
            liveMessage: null,
            pendingUiRequests: [],
        },
    };
}

function httpSnapshot(entryCount: number): SessionWsServerMessage {
    return {
        type: "sync:snapshot",
        cursor: { epoch: RUNTIME, seq: seq(1) },
        snapshot: {
            entriesVersion: ENTRIES_VERSION,
            baseEntryCount: 0,
            entries: { mode: "http", meta: { entryCount } },
            state: sessionState(),
            liveMessage: null,
            pendingUiRequests: [],
        },
    };
}

function deltaFrame(seqNumber: number, delta: SessionDelta): SessionWsServerMessage {
    return { type: "sync:delta", cursor: { epoch: RUNTIME, seq: seq(seqNumber) }, delta };
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
    return {
        role: "assistant",
        content,
        api: "test",
        provider: "test",
        model: "test",
        usage: EMPTY_USAGE,
        stopReason: "pending",
        timestamp,
    };
}

class StorySessionSocket implements WebSocketLike {
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public readonly url: string) {}

    send(): void {}

    close(): void {
        this.readyState = 3;
    }

    open(): void {
        this.readyState = 1;
        this.onopen?.();
    }

    receive(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
    }

    serverClose(code: number, reason: string): void {
        this.readyState = 3;
        this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
    }
}

function createStorySocket(): {
    readonly WebSocket: WebSocketConstructor;
    latest: () => StorySessionSocket | null;
} {
    const instances: StorySessionSocket[] = [];
    class Socket extends StorySessionSocket {
        constructor(url: string) {
            super(url);
            instances.push(this);
        }
    }
    return {
        WebSocket: Socket,
        latest: () => instances.at(-1) ?? null,
    };
}

function createStoryApi(): { getSession: () => Promise<SessionDetailResponse> } {
    let calls = 0;
    return {
        getSession: () => {
            calls += 1;
            if (calls === 1) {
                return Promise.reject(new Error("The session entries could not be read."));
            }
            return Promise.resolve({
                session: summary(),
                entriesVersion: ENTRIES_VERSION,
                baseEntryCount: 0,
                entries: [...TRANSCRIPT_ENTRIES],
            });
        },
    };
}

interface ScenarioContext {
    readonly socket: ReturnType<typeof createStorySocket>;
    readonly store: ReturnType<typeof createSessionStore>;
}

type Scenario = (context: ScenarioContext) => void;

interface PageHarnessProps {
    readonly route: string;
    readonly setup: Scenario;
}

function PageHarness({ route, setup }: PageHarnessProps): ReactElement {
    const [context] = useState(() => {
        const socket = createStorySocket();
        const api = createStoryApi();
        const store = createSessionStore({
            WebSocket: socket.WebSocket,
            apiClient: api,
            reconnectDelayMs: 0,
            maxReconnectAttempts: 0,
            retryDelaysMs: [],
            // A failed entry sync stays visible until the reader presses Retry.
            entriesSyncCooldownMs: 60_000,
        });
        return { socket, store };
    });
    const setupRef = useRef(setup);

    useEffect(() => {
        setupRef.current(context);
    }, [context]);

    return (
        <div className={styles.frame}>
            <MemoryRouter initialEntries={[route]}>
                <Routes>
                    <Route path="/workspace" element={<WorkspacePage sessionStore={context.store} />} />
                    <Route path="/workspace/:sessionId" element={<WorkspacePage sessionStore={context.store} />} />
                </Routes>
            </MemoryRouter>
        </div>
    );
}

const noScenario: Scenario = () => undefined;

const loadingScenario: Scenario = ({ socket }) => {
    socket.latest()?.open();
};

const emptyScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot([]));
};

const transcriptScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot(TRANSCRIPT_ENTRIES));
};

const httpFailureScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(httpSnapshot(TRANSCRIPT_ENTRIES.length));
};

const cachedEntriesScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot(TRANSCRIPT_ENTRIES));
    ws?.receive(
        deltaFrame(2, {
            kind: "entries_appended",
            entriesVersion: ENTRIES_VERSION,
            baseEntryCount: TRANSCRIPT_ENTRIES.length,
            entries: { mode: "http", meta: { entryCount: TRANSCRIPT_ENTRIES.length + 2 } },
        }),
    );
};

const streamingScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    if (ws === null) {
        return;
    }
    const startedAt = Date.now() - 2_000;
    ws.open();
    ws.receive(
        inlineSnapshot([userEntry("s1", null, "Stream the answer as it arrives.", startedAt - 1_000)], {
            isStreaming: true,
        }),
    );
    ws.receive(
        deltaFrame(2, {
            kind: "agent_event",
            event: {
                type: "message_start",
                message: assistantMessage(
                    [
                        { type: "thinking", thinking: "Drafting the reply while the reader watches." },
                        { type: "text", text: "" },
                    ],
                    startedAt,
                ),
            },
        }),
    );
    ws.receive(
        deltaFrame(3, {
            kind: "agent_event",
            event: {
                type: "message_update",
                usage: EMPTY_USAGE,
                assistantMessageEvent: { type: "text_start", contentIndex: 1 },
            },
        }),
    );
    ws.receive(
        deltaFrame(4, {
            kind: "agent_event",
            event: {
                type: "message_update",
                usage: EMPTY_USAGE,
                assistantMessageEvent: {
                    type: "text_delta",
                    contentIndex: 1,
                    delta: "Writing the transcript ",
                },
            },
        }),
    );
    ws.receive(
        deltaFrame(5, {
            kind: "agent_event",
            event: {
                type: "message_update",
                usage: EMPTY_USAGE,
                assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "as tokens arrive." },
            },
        }),
    );
    ws.receive(
        deltaFrame(6, {
            kind: "agent_event",
            event: {
                type: "message_update",
                usage: EMPTY_USAGE,
                assistantMessageEvent: { type: "toolcall_start", contentIndex: 2, id: "call-live", toolName: "bash" },
            },
        }),
    );
    ws.receive(
        deltaFrame(7, {
            kind: "agent_event",
            event: {
                type: "message_update",
                usage: EMPTY_USAGE,
                assistantMessageEvent: {
                    type: "toolcall_end",
                    contentIndex: 2,
                    toolCall: {
                        type: "toolCall",
                        id: "call-live",
                        name: "bash",
                        arguments: { command: "pnpm test:storybook" },
                    },
                },
            },
        }),
    );
};

const closedScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot([]));
    ws?.serverClose(SESSION_CLOSE_CODE.sessionClosed, "The session was closed by the user.");
};

const disconnectedScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot([]));
    ws?.serverClose(1006, "");
};

const meta = {
    title: "Pages/Workspace/WorkspacePage",
    component: WorkspacePage,
    parameters: {
        layout: "fullscreen",
    },
} satisfies Meta<typeof WorkspacePage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NoSessionSelected: Story = {
    render: () => <PageHarness route="/workspace" setup={noScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "No session selected" })).toBeVisible();
        await expect(canvas.getByText("The message composer arrives in a later update.")).toBeVisible();
    },
};

export const InvalidSessionId: Story = {
    render: () => <PageHarness route="/workspace/not%20valid" setup={noScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "Unknown session" })).toBeVisible();
        await expect(canvas.getByText("not valid")).toBeVisible();
    },
};

export const LoadingSession: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={loadingScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("progressbar", { name: "Loading session" })).toBeVisible();
    },
};

export const EmptySession: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={emptyScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "Empty session" })).toBeVisible();
    },
};

export const Transcript: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={transcriptScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("Show the transcript view for this session.")).toBeVisible();
        await expect(canvas.getByRole("button", { name: "Worked for 4s" })).toBeVisible();
        await expect(canvas.getByText("The transcript view is connected to the session store.")).toBeVisible();
        await expect(canvas.getByRole("region", { name: "Transcript" })).toBeVisible();
    },
};

export const SyncErrorRetry: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={httpFailureScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "Cannot load the transcript" })).toBeVisible();
        await expect(canvas.getByText("The session entries could not be read.")).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "Retry" }));

        await expect(await canvas.findByText("Show the transcript view for this session.")).toBeVisible();
        await waitFor(async () => {
            await expect(canvas.queryByRole("heading", { name: "Cannot load the transcript" })).not.toBeInTheDocument();
        });
    },
};

export const SyncErrorBannerKeepsCachedEntries: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={cachedEntriesScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const alert = await canvas.findByRole("alert");
        await expect(alert).toHaveTextContent("The transcript stopped syncing.");
        await expect(canvas.getByText("Show the transcript view for this session.")).toBeVisible();

        await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));

        await waitFor(async () => {
            await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
        });
        await expect(canvas.getByText("Show the transcript view for this session.")).toBeVisible();
    },
};

export const StreamingAssistant: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={streamingScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("Stream the answer as it arrives.")).toBeVisible();

        const trigger = await canvas.findByRole("button", { name: /^Working for / });
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        await expect(canvas.getByText("Working...")).toBeVisible();

        await userEvent.click(trigger);
        await expect(trigger).toHaveAttribute("aria-expanded", "true");
        await expect(canvas.getByText("Writing the transcript as tokens arrive.")).toBeVisible();
        await expect(canvas.getByRole("button", { name: /Bash/ })).toBeVisible();

        const runningTimer = canvasElement.querySelector("[data-running='true']");
        await expect(runningTimer).toHaveTextContent(/^\d+\.\ds$/);
    },
};

export const SessionClosed: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={closedScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "Session closed" })).toBeVisible();
        await expect(canvas.getByText("The session was closed by the user.")).toBeVisible();
    },
};

export const ConnectionLost: Story = {
    render: () => <PageHarness route={`/workspace/${SESSION_ID}`} setup={disconnectedScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "Connection lost" })).toBeVisible();
        await expect(canvas.getByText("Cannot reconnect to the session.")).toBeVisible();
    },
};
