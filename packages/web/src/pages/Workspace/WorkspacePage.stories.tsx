import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import {
    EMPTY_SESSION_UI_STATE,
    SESSION_CLOSE_CODE,
    type ExtensionDialogRequest,
    type SessionDelta,
    type SessionDetailResponse,
    type SessionStateSnapshot,
    type SessionSummary,
    type SessionWsServerMessage,
} from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { ToastProvider } from "@components";
import { ev, sessionEpoch, sessionSeq, sid } from "@/storybook/ids";
import { makeStorySessionState, makeStorySessionSummary } from "@/storybook/fixtures";
import { toastManager } from "@/lib/toast";
import { createStorySocket, type StorySocket } from "@/storybook/socket";
import { createSessionStore } from "@/stores/session";

import { WorkspacePage } from "./WorkspacePage";
import styles from "./WorkspacePage.stories.module.css";

const SESSION_ID = sid("session-1");
const ENTRIES_VERSION = ev("3:1.5.2");
const RUNTIME = sessionEpoch("story-runtime-1");
const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const summary = (): SessionSummary =>
    makeStorySessionSummary(SESSION_ID, {
        firstMessage: "Show the transcript view.",
        messageCount: 4,
        attachedClients: 1,
    });

/** The page story renders a finished four-message session unless a scenario changes it. */
const sessionState = (overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot =>
    makeStorySessionState(SESSION_ID, { messageCount: 4, ...overrides });

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
        cursor: { epoch: RUNTIME, seq: sessionSeq(1) },
        snapshot: {
            entriesVersion: ENTRIES_VERSION,
            baseEntryCount: 0,
            entries: { mode: "inline", data: [...entries] },
            state: sessionState(overrides),
            liveMessage: null,
            pendingUiRequests: [],
            uiState: EMPTY_SESSION_UI_STATE,
        },
    };
}

function httpSnapshot(entryCount: number): SessionWsServerMessage {
    return {
        type: "sync:snapshot",
        cursor: { epoch: RUNTIME, seq: sessionSeq(1) },
        snapshot: {
            entriesVersion: ENTRIES_VERSION,
            baseEntryCount: 0,
            entries: { mode: "http", meta: { entryCount } },
            state: sessionState(),
            liveMessage: null,
            pendingUiRequests: [],
            uiState: EMPTY_SESSION_UI_STATE,
        },
    };
}

function deltaFrame(seqNumber: number, delta: SessionDelta): SessionWsServerMessage {
    return { type: "sync:delta", cursor: { epoch: RUNTIME, seq: sessionSeq(seqNumber) }, delta };
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
            <ToastProvider toastManager={toastManager}>
                <MemoryRouter initialEntries={[route]}>
                    <Routes>
                        <Route path="/workspace" element={<WorkspacePage sessionStore={context.store} />} />
                        <Route path="/workspace/:sessionId" element={<WorkspacePage sessionStore={context.store} />} />
                    </Routes>
                </MemoryRouter>
            </ToastProvider>
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

type Story = StoryObj<typeof WorkspacePage>;

export const NoSessionSelected: Story = {
    render: () => <PageHarness route="/workspace" setup={noScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { name: "No session selected" })).toBeVisible();
        await expect(canvas.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
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
        await expect(canvas.getByRole("button", { name: "Worked for 4.0s" })).toBeVisible();
        await expect(canvas.getByText("The transcript view is connected to the session store.")).toBeVisible();
        await expect(canvas.getByRole("region", { name: "Transcript" })).toBeVisible();
        await expect(canvas.getByRole("textbox", { name: "Message" })).toBeEnabled();
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

const EXTENSION_REQUEST: ExtensionDialogRequest = {
    type: "extension_ui_request",
    id: "req-story-1",
    method: "confirm",
    title: "Continue?",
    message: "This resumes the turn.",
};

function createExtensionPromptStory(): Story {
    let extensionSocket: StorySocket | null = null;
    const extensionPromptScenario: Scenario = ({ socket }) => {
        extensionSocket = socket.latest();
        const ws = extensionSocket;
        ws?.open();
        ws?.receive(inlineSnapshot([]));
    };

    return {
        render: () => <PageHarness route="/workspace/session-1" setup={extensionPromptScenario} />,
        play: async ({ canvasElement }) => {
            const canvas = within(canvasElement);
            await expect(canvas.getByRole("textbox", { name: "Message" })).toBeEnabled();

            extensionSocket?.receive(deltaFrame(2, { kind: "ui_request", request: EXTENSION_REQUEST }));

            const dialog = await within(document.body).findByRole("dialog", { name: "Continue?" });
            await expect(within(dialog).getByText("This resumes the turn.")).toBeVisible();
            // The modal makes the rest of the page inert, so the composer is not reachable by role.
            await expect(canvas.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();

            await userEvent.click(within(dialog).getByRole("button", { name: "Minimize prompt" }));
            await waitFor(() =>
                expect(within(document.body).queryByRole("dialog", { name: "Continue?" })).not.toBeInTheDocument(),
            );

            const input = canvas.getByRole("textbox", { name: "Message" });
            await expect(input).toBeDisabled();
            await expect(input).toHaveAttribute("placeholder", "Waiting for an extension answer.");
            await expect(canvas.getByRole("button", { name: "Show extension prompt, 1 waiting" })).toBeVisible();

            await userEvent.click(canvas.getByRole("button", { name: "Show extension prompt, 1 waiting" }));
            const reopened = await within(document.body).findByRole("dialog", { name: "Continue?" });
            await userEvent.click(within(reopened).getByRole("button", { name: "Confirm" }));

            await waitFor(() => expect(extensionSocket?.sent).toHaveLength(1));
            const frame: unknown = JSON.parse(extensionSocket?.sent[0] ?? "{}");
            await expect(frame).toEqual({
                type: "rpc:ui_response",
                response: { type: "extension_ui_response", id: "req-story-1", confirmed: true },
            });

            extensionSocket?.receive(deltaFrame(3, { kind: "ui_resolved", requestId: "req-story-1" }));

            await waitFor(() =>
                expect(within(document.body).queryByRole("dialog", { name: "Continue?" })).not.toBeInTheDocument(),
            );
            await waitFor(() =>
                expect(
                    canvas.queryByRole("button", { name: "Show extension prompt, 1 waiting" }),
                ).not.toBeInTheDocument(),
            );
            await expect(canvas.getByRole("textbox", { name: "Message" })).toBeEnabled();
        },
    };
}

const noticeScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot([]));
    ws?.receive(
        deltaFrame(2, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "req-notify",
                method: "notify",
                message: "Reload the extension to pick up changes.",
                notifyType: "warning",
            },
        }),
    );
    ws?.receive(
        deltaFrame(3, {
            kind: "extension_error",
            extensionPath: "/home/u/.pi/extensions/lint.ts",
            event: "tool_call",
            error: "Cannot read the config",
        }),
    );
};

export const ExtensionNotices: Story = {
    parameters: {
        // Base UI hides high-priority toasts from assistive technology (their content is announced
        // by its own role="alert" region) but keeps the toast focusable, so axe reports
        // aria-hidden-focus. Track the upstream fix instead of changing the toast stack.
        a11y: { test: "todo" },
    },
    render: () => <PageHarness route="/workspace/session-1" setup={noticeScenario} />,
    play: async () => {
        const warning = await within(document.body).findByRole("dialog", {
            name: "Reload the extension to pick up changes.",
        });
        await waitFor(() => expect(warning).toBeVisible());
        // High-priority toasts are alertdialogs hidden from assistive technology unless the viewport
        // has focus, so query the hidden element and assert its content.
        const failure = await within(document.body).findByRole("alertdialog", { hidden: true });
        await waitFor(() => expect(failure).toBeVisible());
        await expect(failure).toHaveTextContent("Extension failed");
        await expect(within(failure).getByText("/home/u/.pi/extensions/lint.ts: Cannot read the config")).toBeVisible();

        // The manager is a module singleton, so clear the stack and wait for the exit animation.
        toastManager.close();
        await waitFor(() =>
            expect(within(document.body).queryByRole("alertdialog", { hidden: true })).not.toBeInTheDocument(),
        );
        await waitFor(() =>
            expect(
                within(document.body).queryByRole("dialog", { name: "Reload the extension to pick up changes." }),
            ).not.toBeInTheDocument(),
        );
    },
};

const chromeScenario: Scenario = ({ socket }) => {
    const ws = socket.latest();
    ws?.open();
    ws?.receive(inlineSnapshot([]));
    ws?.receive(
        deltaFrame(2, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "chrome-status-git",
                method: "setStatus",
                statusKey: "git",
                statusText: "main",
            },
        }),
    );
    ws?.receive(
        deltaFrame(3, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "chrome-status-lint",
                method: "setStatus",
                statusKey: "lint",
                statusText: "clean",
            },
        }),
    );
    ws?.receive(
        deltaFrame(4, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "chrome-widget-above",
                method: "setWidget",
                widgetKey: "above",
                widgetLines: ["Above widget"],
            },
        }),
    );
    ws?.receive(
        deltaFrame(5, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "chrome-widget-below",
                method: "setWidget",
                widgetKey: "below",
                widgetLines: ["Below widget"],
                widgetPlacement: "belowEditor",
            },
        }),
    );
    ws?.receive(
        deltaFrame(6, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "chrome-title",
                method: "setTitle",
                title: "Release checklist",
            },
        }),
    );
};

export const ExtensionChrome: Story = {
    render: () => <PageHarness route="/workspace/session-1" setup={chromeScenario} />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        // Status texts join in key order: git=main, lint=clean.
        await expect(canvas.getByText("main clean")).toBeVisible();
        await expect(canvas.getByText("Above widget")).toBeVisible();
        await expect(canvas.getByText("Below widget")).toBeVisible();
        await waitFor(() => expect(document.title).toBe("Release checklist"));
    },
};

export const ExtensionPrompt: Story = createExtensionPromptStory();
