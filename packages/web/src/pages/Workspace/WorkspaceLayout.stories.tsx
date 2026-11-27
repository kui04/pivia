import { initialSyncSeq, nextSyncSeq, type SessionSummary } from "@pivia/protocol";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect, fn, waitFor, within } from "storybook/test";

import { ToastProvider } from "@components/Toast";
import { toastManager } from "@/lib/toast";
import { makeStorySessionSummary } from "@/storybook/fixtures";
import { catalogEpoch, sid } from "@/storybook/ids";
import { createStorySocket } from "@/storybook/socket";
import type { WebSocketConstructor } from "@/lib/transport";
import { createAuthStore, type AuthClient } from "@/stores/auth";
import { createSessionStore } from "@/stores/session";
import { createWorkspaceStore, type WorkspaceCatalogCache } from "@/stores/workspace";

import { WorkspaceLayout, type WorkspaceApiClient } from "./WorkspaceLayout";
import { WorkspacePage } from "./WorkspacePage";
import styles from "./WorkspaceLayout.stories.module.css";

const S1 = sid("session-1");
const S2 = sid("session-2");
const INITIAL_SEQ = initialSyncSeq<"catalog">();
const STORY_EPOCH = catalogEpoch("story-epoch-1");

const noopCache: WorkspaceCatalogCache = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
};

/** Session socket that stays silent; the layout stories only exercise the shell. */
const SilentSessionSocket = createStorySocket().WebSocket;

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
 * The layout stories exercise the shell, so the socket replaces the real `/ws/workspace` endpoint
 * and the routed page never reaches a real session socket.
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
}

function WorkspaceHarness({
    initialRoute,
    initialSessions,
    apiClient,
    socketController,
}: WorkspaceHarnessProps): ReactElement {
    const [setup] = useState(() => {
        const socket = socketController ?? createFakeWorkspaceSocket(initialSessions);
        const workspaceStore = createWorkspaceStore({ cache: noopCache });
        const authStore = createAuthStore(noopAuthClient);
        const sessionStore = createSessionStore({
            WebSocket: SilentSessionSocket,
            apiClient: {
                getSession: () => Promise.reject(new Error("The layout story does not load session entries.")),
            },
            reconnectDelayMs: 0,
            maxReconnectAttempts: 0,
            retryDelaysMs: [],
        });
        return { socket, workspaceStore, authStore, sessionStore };
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
                                    authStore={setup.authStore}
                                    WebSocket={setup.socket.WebSocket}
                                    minRefreshDurationMs={0}
                                />
                            }
                        >
                            <Route index element={<WorkspacePage sessionStore={setup.sessionStore} />} />
                            <Route path=":sessionId" element={<WorkspacePage sessionStore={setup.sessionStore} />} />
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

        const topbar = canvas.getByRole("banner");
        await userEvent.click(within(topbar).getByRole("button", { name: "Session actions" }));
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

        const topbar = canvas.getByRole("banner");
        await userEvent.click(within(topbar).getByRole("button", { name: "Session actions" }));
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
