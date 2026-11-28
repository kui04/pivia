import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { EMPTY_SESSION_UI_STATE, initialSyncSeq, nextSyncSeq, type SessionSummary } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, fireEvent, fn, waitFor, within } from "storybook/test";

import { ToastProvider } from "@components/Toast";
import { toastManager } from "@/lib/toast";
import { requireElement } from "@/storybook/dom";
import { makeStorySessionState, makeStorySessionSummary } from "@/storybook/fixtures";
import { catalogEpoch, ev, sessionEpoch, sessionSeq, sid } from "@/storybook/ids";
import { createStorySocket } from "@/storybook/socket";
import type { WebSocketConstructor } from "@/lib/transport";
import { createAuthStore, type AuthClient } from "@/stores/auth";
import { createSessionPool } from "@/stores/session";
import { createWorkspaceStore, type WorkspaceCatalogCache } from "@/stores/workspace";

import { WorkspaceLayout, type WorkspaceApiClient } from "./WorkspaceLayout";
import styles from "./WorkspaceLayout.stories.module.css";

const S1 = sid("session-1");
const S2 = sid("session-2");
const INITIAL_SEQ = initialSyncSeq<"catalog">();
const STORY_EPOCH = catalogEpoch("story-epoch-1");
const SESSION_EPOCH = sessionEpoch("story-session-epoch-1");
const ENTRIES_VERSION = ev("3:1.5.2");

const noopCache: WorkspaceCatalogCache = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
};

/** Session socket that stays silent; shell-only stories do not load transcripts. */
const SilentSessionSocket = createStorySocket().WebSocket;

function userEntry(id: string, text: string): FileEntry {
    return {
        type: "message",
        id,
        parentId: null,
        timestamp: "2026-04-01T00:00:01.000Z",
        message: { role: "user", content: text, timestamp: 1_000 },
    };
}

/** Session socket that answers each `/ws/sessions/:id` connection with a seeded inline transcript. */
function createLiveSessionSocket(transcripts: Readonly<Record<string, readonly FileEntry[]>>): WebSocketConstructor {
    return createStorySocket((active) => {
        const pathname = new URL(active.url, "http://localhost").pathname;
        const rawId = pathname.split("/").at(-1) ?? "";
        const entries = transcripts[rawId] ?? [];
        const sessionId = rawId === S2 ? S2 : S1;
        active.open();
        active.receive({
            type: "sync:snapshot",
            cursor: { epoch: SESSION_EPOCH, seq: sessionSeq(1) },
            snapshot: {
                entriesVersion: ENTRIES_VERSION,
                baseEntryCount: 0,
                entries: { mode: "inline", data: [...entries] },
                state: makeStorySessionState(sessionId, { messageCount: entries.length }),
                liveMessage: null,
                pendingUiRequests: [],
                uiState: EMPTY_SESSION_UI_STATE,
            },
        });
    }).WebSocket;
}

const noopAuthClient: AuthClient = {
    getAuthStatus: () => Promise.resolve({ authRequired: false, authenticated: true }),
    login: () => Promise.resolve({ authenticated: true }),
    logout: () => Promise.resolve({ authenticated: false }),
};

interface HarnessSocketController {
    readonly WebSocket: WebSocketConstructor;
    emitMessage: (payload: unknown) => void;
}

/**
 * A workspace socket that opens at construction and answers with the story's starting catalog.
 *
 * Replaces `/ws/workspace` inside stories.
 */
function createFakeWorkspaceSocket(initialSessions: readonly SessionSummary[]): HarnessSocketController {
    const socket = createStorySocket((active) => {
        active.open();
        active.receive({
            type: "sync:snapshot",
            cursor: { epoch: STORY_EPOCH, seq: INITIAL_SEQ },
            snapshot: {
                sessions: initialSessions,
                updatedAtMs: 10_000,
            },
        });
    });

    return {
        WebSocket: socket.WebSocket,
        emitMessage(payload) {
            const active = socket.latest();
            if (active === null) {
                throw new Error("Expected active fake workspace socket");
            }
            active.receive(payload);
        },
    };
}

interface WorkspaceHarnessProps {
    readonly initialRoute: string;
    readonly initialSessions: readonly SessionSummary[];
    readonly apiClient: WorkspaceApiClient;
    readonly socketController?: HarnessSocketController | undefined;
    readonly sessionWebSocket?: WebSocketConstructor | undefined;
    readonly minPaneWidthPx?: number | undefined;
    readonly minPaneHeightPx?: number | undefined;
}

function WorkspaceHarness({
    initialRoute,
    initialSessions,
    apiClient,
    socketController,
    sessionWebSocket = SilentSessionSocket,
    minPaneWidthPx,
    minPaneHeightPx,
}: WorkspaceHarnessProps): ReactElement {
    const [setup] = useState(() => {
        const socket = socketController ?? createFakeWorkspaceSocket(initialSessions);
        const workspaceStore = createWorkspaceStore({ cache: noopCache });
        const authStore = createAuthStore(noopAuthClient);
        const sessionPool = createSessionPool({
            WebSocket: sessionWebSocket,
            apiClient: {
                getSession: () => Promise.reject(new Error("The layout story does not load session entries via HTTP.")),
            },
            reconnectDelayMs: 0,
            maxReconnectAttempts: 0,
            retryDelaysMs: [],
        });
        return { socket, workspaceStore, authStore, sessionPool };
    });

    return (
        <ToastProvider toastManager={toastManager} position="top-center">
            <MemoryRouter initialEntries={[initialRoute]}>
                <div className={styles.frame}>
                    <Routes>
                        <Route
                            path="/workspace"
                            element={
                                <WorkspaceLayout
                                    apiClient={apiClient}
                                    workspaceStore={setup.workspaceStore}
                                    sessionPool={setup.sessionPool}
                                    authStore={setup.authStore}
                                    WebSocket={setup.socket.WebSocket}
                                    minRefreshDurationMs={0}
                                    persistLayout={false}
                                    minPaneWidthPx={minPaneWidthPx}
                                    minPaneHeightPx={minPaneHeightPx}
                                />
                            }
                        >
                            <Route index element={null} />
                            <Route path=":sessionId" element={null} />
                        </Route>
                    </Routes>
                </div>
            </MemoryRouter>
        </ToastProvider>
    );
}

function createMockApiClient(overrides: Partial<WorkspaceApiClient> = {}): WorkspaceApiClient {
    return {
        listSessions: fn(() =>
            Promise.resolve({
                sessions: [makeStorySessionSummary(S1)],
                updatedAtMs: 10_000,
                cursor: {
                    epoch: STORY_EPOCH,
                    seq: INITIAL_SEQ,
                },
            }),
        ),
        getAuthStatus: fn(() => Promise.resolve({ authRequired: false, authenticated: true })),
        listDirectories: fn(() =>
            Promise.resolve({
                path: "/home/u/pivia",
                parent: "/home/u",
                directories: ["packages"],
                truncated: false,
            }),
        ),
        createSession: fn((cwd: string) =>
            Promise.resolve({
                session: makeStorySessionSummary(S2, {
                    cwd,
                    name: "Created session",
                    modifiedAtMs: 20_000,
                }),
            }),
        ),
        closeSession: fn(() => Promise.resolve({ closed: true })),
        ...overrides,
    };
}

const meta = {
    title: "Pages/Workspace/WorkspaceLayout",
    component: WorkspaceLayout,
    parameters: {
        layout: "fullscreen",
    },
} satisfies Meta<typeof WorkspaceLayout>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CreateSessionNavigates: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute="/workspace"
            initialSessions={[makeStorySessionSummary(S1)]}
            apiClient={createMockApiClient()}
        />
    ),
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { level: 1, name: "No session selected" })).toBeVisible();

        await userEvent.click(canvas.getByRole("button", { name: "New session" }));
        const dialog = await within(document.body).findByRole("dialog", { name: "New session" });
        await waitFor(() => expect(within(dialog).getByLabelText("Working directory")).toHaveValue("/home/u/pivia"));

        await userEvent.click(within(dialog).getByRole("button", { name: "Create session" }));
        await expect(await canvas.findByRole("heading", { level: 1, name: "Created session" })).toBeVisible();
        // The sidebar row proves the catalog delta landed next to the route change.
        await expect(await canvas.findByRole("button", { name: /Created session/ })).toBeVisible();
    },
};

export const CloseIdleSessionWarns: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute={`/workspace/${S1}`}
            initialSessions={[makeStorySessionSummary(S1)]}
            apiClient={createMockApiClient({
                closeSession: fn(() => Promise.resolve({ closed: false })),
            })}
        />
    ),
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { level: 1, name: "First task" })).toBeVisible();

        const sidebar = canvas.getByRole("complementary", { name: "Sessions" });
        const rowButton = within(sidebar).getByRole("button", { name: /First task/ });
        rowButton.focus();
        const row = requireElement(rowButton.closest("li"), "First task row");
        await userEvent.click(within(row).getByRole("button", { name: "Session actions" }));
        const closeItem = await within(document.body).findByRole("menuitem", { name: "Close session" });
        await userEvent.click(closeItem);

        await expect(await within(document.body).findByText("Session is not running")).toBeVisible();
        await expect(canvas.getByRole("heading", { level: 1, name: "First task" })).toBeVisible();
    },
};

export const CloseRunningSessionNavigatesHome: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute={`/workspace/${S1}`}
            initialSessions={[makeStorySessionSummary(S1, { runtimeState: "streaming", attachedClients: 1 })]}
            apiClient={createMockApiClient({
                closeSession: fn(() => Promise.resolve({ closed: true })),
            })}
        />
    ),
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { level: 1, name: "First task" })).toBeVisible();

        const sidebar = canvas.getByRole("complementary", { name: "Sessions" });
        const rowButton = within(sidebar).getByRole("button", { name: /First task/ });
        rowButton.focus();
        const row = requireElement(rowButton.closest("li"), "First task row");
        await userEvent.click(within(row).getByRole("button", { name: "Session actions" }));
        const closeItem = await within(document.body).findByRole("menuitem", { name: "Close session" });
        await userEvent.click(closeItem);

        await expect(await canvas.findByRole("heading", { level: 1, name: "No session selected" })).toBeVisible();
        await waitFor(() => expect(canvas.queryByText(S1)).not.toBeInTheDocument());
    },
};

const removedSocket = createFakeWorkspaceSocket([makeStorySessionSummary(S1)]);

export const RemovedSessionClearsRoute: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute={`/workspace/${S1}`}
            initialSessions={[makeStorySessionSummary(S1)]}
            apiClient={createMockApiClient()}
            socketController={removedSocket}
        />
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { level: 1, name: "First task" })).toBeVisible();

        removedSocket.emitMessage({
            type: "sync:delta",
            cursor: { epoch: STORY_EPOCH, seq: nextSyncSeq(INITIAL_SEQ) },
            delta: { op: "remove", id: S1 },
        });

        await expect(await canvas.findByRole("heading", { level: 1, name: "No session selected" })).toBeVisible();
        await waitFor(() => expect(canvas.queryByText(S1)).not.toBeInTheDocument());
    },
};

export const MultiPaneSplitAndResize: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute={`/workspace/${S1}`}
            initialSessions={[
                makeStorySessionSummary(S1, { name: "Alpha session" }),
                makeStorySessionSummary(S2, { name: "Beta session" }),
            ]}
            apiClient={createMockApiClient()}
            sessionWebSocket={createLiveSessionSocket({
                [S1]: [userEntry("m1", "Prompt inside Alpha")],
                [S2]: [userEntry("m2", "Prompt inside Beta")],
            })}
        />
    ),
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByText("Prompt inside Alpha")).toBeVisible();

        // Split right via Beta session's sidebar row menu to open Beta beside Alpha.
        const sidebar = canvas.getByRole("complementary", { name: "Sessions" });
        const betaRowButton = within(sidebar).getByRole("button", { name: /Beta session/ });
        betaRowButton.focus();
        const betaRow = requireElement(betaRowButton.closest("li"), "Beta session row");
        await userEvent.click(within(betaRow).getByRole("button", { name: "Session actions" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Split right" }));
        const separator = await canvas.findByRole("slider", { name: "Resize horizontal split" });
        await expect(separator).toHaveAttribute("aria-valuenow", "50");

        await expect(await canvas.findByText("Prompt inside Beta")).toBeVisible();
        await expect(canvas.getByText("Prompt inside Alpha")).toBeVisible();

        // Focused pane owns the single h1; unfocused pane renders h2, and only pane titles (not the
        // surrounding header bar) are draggable.
        const betaHeading = canvas.getByRole("heading", { level: 1, name: "Beta session" });
        const alphaHeading = canvas.getByRole("heading", { level: 2, name: "Alpha session" });
        await expect(betaHeading).toBeVisible();
        await expect(alphaHeading).toBeVisible();
        await expect(alphaHeading).toHaveAttribute("draggable", "true");
        await expect(canvas.getByRole("banner")).not.toHaveAttribute("draggable");

        // Keyboard resize respects pixel bounds reflected in aria-valuemin/aria-valuemax.
        separator.focus();
        await userEvent.keyboard("{Home}");
        await expect(separator.getAttribute("aria-valuenow")).toBe(separator.getAttribute("aria-valuemin"));
        await userEvent.keyboard("{Enter}");
        await expect(separator).toHaveAttribute("aria-valuenow", "50");
        await userEvent.keyboard("{ArrowRight}");
        await expect(separator).toHaveAttribute("aria-valuenow", "55");

        // Dragging Alpha session row onto Beta pane's bottom edge shows drop preview and docks Alpha below Beta.
        const alphaRowButton = within(sidebar).getByRole("button", { name: /Alpha session/ });
        const betaPane = canvas.getByRole("region", { name: "Beta session" });
        const rect = betaPane.getBoundingClientRect();
        const dataTransfer = new DataTransfer();
        const dropCoords = {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: rect.left + rect.width / 2,
            clientY: rect.bottom - 10,
        };
        await fireEvent(alphaRowButton, new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
        await fireEvent(betaPane, new DragEvent("dragenter", dropCoords));
        await fireEvent(betaPane, new DragEvent("dragover", dropCoords));
        await expect(await canvas.findByText("Split down")).toBeVisible();
        await fireEvent(betaPane, new DragEvent("drop", dropCoords));
        await fireEvent(alphaRowButton, new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
        await expect(await canvas.findByRole("slider", { name: "Resize vertical split" })).toBeVisible();
        await expect(canvas.getByRole("heading", { level: 1, name: "Alpha session" })).toBeVisible();

        // Detaching Alpha from the pane overflow menu clears that pane slot without deleting the session.
        await userEvent.click(canvas.getByRole("button", { name: "Session actions (Alpha session)" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Detach session" }));
        await expect(await canvas.findByRole("heading", { level: 1, name: "No session selected" })).toBeVisible();
        await expect(canvas.getByRole("heading", { level: 2, name: "Beta session" })).toBeVisible();

        // Closing the empty pane via its menu collapses back to a single focused Beta pane.
        await userEvent.click(canvas.getByRole("button", { name: "Pane actions (No session selected)" }));
        await userEvent.click(await within(document.body).findByRole("menuitem", { name: "Close pane" }));
        await expect(canvas.queryByRole("slider")).not.toBeInTheDocument();
        await expect(canvas.getByRole("heading", { level: 1, name: "Beta session" })).toBeVisible();
    },
};

export const MinPaneSizeBlocksSplit: Story = {
    render: () => (
        <WorkspaceHarness
            initialRoute={`/workspace/${S1}`}
            initialSessions={[
                makeStorySessionSummary(S1, { name: "Alpha session" }),
                makeStorySessionSummary(S2, { name: "Beta session" }),
            ]}
            apiClient={createMockApiClient()}
            minPaneWidthPx={800}
            minPaneHeightPx={200}
        />
    ),
    play: async ({ canvasElement, userEvent }) => {
        const canvas = within(canvasElement);
        await expect(await canvas.findByRole("heading", { level: 1, name: "Alpha session" })).toBeVisible();

        const sidebar = canvas.getByRole("complementary", { name: "Sessions" });
        const betaRowButton = within(sidebar).getByRole("button", { name: /Beta session/ });
        betaRowButton.focus();
        const betaRow = requireElement(betaRowButton.closest("li"), "Beta session row");
        await userEvent.click(within(betaRow).getByRole("button", { name: "Session actions" }));

        const splitRight = await within(document.body).findByRole("menuitem", { name: "Split right" });
        const splitDown = await within(document.body).findByRole("menuitem", { name: "Split down" });
        await expect(splitRight).toHaveAttribute("aria-disabled", "true");
        await expect(splitDown).not.toHaveAttribute("aria-disabled", "true");
    },
};
