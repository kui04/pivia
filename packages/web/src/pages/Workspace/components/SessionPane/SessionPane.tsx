import { assertNever, EMPTY_SESSION_UI_STATE, type ExtensionDialogRequest, type SessionId } from "@pivia/protocol";
import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";

import { Button, LoadingIndicator } from "@components";
import { useFrameCoalescedValue, type FrameCoalesceOptions } from "@/hooks";
import { ensureFontRole } from "@/lib";
import { showError, showWarning, toastManager } from "@/lib/toast";
import {
    createTranscriptRowBuilder,
    projectSessionTranscript,
    type SessionActivityNotice,
    type SessionLiveActivity,
    type SessionNotice,
    type SessionStoreInstance,
    type TranscriptItem,
} from "@/stores/session";
import type { SelectedSession } from "@/stores/workspace";

import type { PaneTarget } from "../../splitLayout";
import { selectWorkspaceView, type WorkspaceView } from "../../workspaceView";
import { Composer } from "../Composer";
import { ExtensionUiChrome, ExtensionUiPrompt } from "../ExtensionUi";
import { SessionStatsDialog } from "../SessionStatsDialog";
import { SessionStatusBar } from "../SessionStatusBar";
import { Topbar } from "../Topbar";
import { collectQueuedEntries, Transcript, type QueuedEntry } from "../Transcript";
import styles from "./SessionPane.module.css";

/** Header configuration passed from {@link SplitWorkspace} when rendering inside a split shell. */
export interface SessionPaneHeaderProps {
    readonly session: SelectedSession | null;
    readonly sidebarOpen: boolean;
    readonly showSidebarToggle: boolean;
    readonly headingLevel: 1 | 2;
    readonly focused: boolean;
    readonly paneCount: number;
    readonly closing: boolean;
    readonly compacting: boolean;
    readonly draggable?: boolean | undefined;
    readonly onDragStart?: ((event: DragEvent<HTMLElement>) => void) | undefined;
    readonly onDragEnd?: (() => void) | undefined;
    readonly onToggleSidebar: () => void;
    readonly onCopySessionId: (id: SessionId) => void;
    readonly onDetachSession: (id: SessionId) => void;
    readonly onRenameSession?: ((session: SelectedSession) => void) | undefined;
    readonly onCompactSession?: ((id: SessionId) => void) | undefined;
    readonly onClosePane?: (() => void) | undefined;
}

/** Props for {@link SessionPane}. */
export interface SessionPaneProps {
    readonly target: PaneTarget;
    readonly sessionStore: SessionStoreInstance | null;
    readonly header?: SessionPaneHeaderProps | undefined;
    readonly onFocus?: (() => void) | undefined;
    readonly onOpenLink: (href: string) => void;
}

function pushToast(id: string, tone: SessionNotice["tone"], title: string, description?: string): void {
    if (tone === "error") {
        showError({ id, title, description });
        return;
    }
    if (tone === "warning") {
        showWarning({ id, title, description });
        return;
    }
    toastManager.add({
        id,
        type: "info",
        priority: "low",
        title,
        description,
    });
}

/** Report one extension notice through the shared toast stack. */
function reportNotice(notice: SessionNotice): void {
    pushToast(notice.id, notice.tone, notice.title, notice.description ?? undefined);
}

const IDLE_ACTIVITY: SessionLiveActivity = { kind: "idle" };
const WORKING_ACTIVITY: SessionLiveActivity = { kind: "working" };
const EMPTY_QUEUE: readonly string[] = [];
const EMPTY_QUEUED_ENTRIES: readonly QueuedEntry[] = [];
const EMPTY_NOTICES: readonly SessionNotice[] = [];
const EMPTY_UI_REQUESTS: readonly ExtensionDialogRequest[] = [];

interface ConnectedTranscriptStageProps {
    readonly sessionId: SessionId;
    readonly sessionStore: SessionStoreInstance;
    readonly routeMatchesStore: boolean;
    readonly status: ReturnType<SessionStoreInstance["getState"]>["status"];
    readonly entriesSync: ReturnType<SessionStoreInstance["getState"]>["entriesSync"];
    readonly lastError: string | null;
    readonly composerConnected: boolean;
    readonly onClearQueue: (() => void) | undefined;
    readonly clearingQueue: boolean;
    readonly onOpenLink: (href: string) => void;
    readonly onRetryEntriesSync: () => void;
}

interface CoalescedLiveStreamInput {
    readonly liveMessage: ReturnType<SessionStoreInstance["getState"]>["liveMessage"];
    readonly liveToolExecutions: ReturnType<SessionStoreInstance["getState"]>["liveToolExecutions"];
    readonly runtimeActive: boolean;
}

function shouldFlushLiveStreamInput(prev: CoalescedLiveStreamInput, next: CoalescedLiveStreamInput): boolean {
    if (prev.runtimeActive !== next.runtimeActive || prev.liveMessage.kind !== next.liveMessage.kind) {
        return true;
    }
    if (
        prev.liveMessage.kind === "streaming" &&
        next.liveMessage.kind === "streaming" &&
        prev.liveMessage.message.timestamp !== next.liveMessage.message.timestamp
    ) {
        return true;
    }
    const prevTools = prev.liveToolExecutions;
    const nextTools = next.liveToolExecutions;
    const prevKeys = Object.keys(prevTools);
    const nextKeys = Object.keys(nextTools);
    if (prevKeys.length !== nextKeys.length) {
        return true;
    }
    for (const toolId of nextKeys) {
        if (prevTools[toolId]?.kind !== nextTools[toolId]?.kind) {
            return true;
        }
    }
    return false;
}

const LIVE_STREAM_COALESCE_OPTIONS: FrameCoalesceOptions<CoalescedLiveStreamInput> = {
    flushImmediately: shouldFlushLiveStreamInput,
};

/** Subscribes to transcript entries & live streaming deltas without re-rendering Composer/Topbar. */
function ConnectedTranscriptStage({
    sessionId,
    sessionStore,
    routeMatchesStore,
    status,
    entriesSync,
    lastError,
    composerConnected,
    onClearQueue,
    clearingQueue,
    onOpenLink,
    onRetryEntriesSync,
}: ConnectedTranscriptStageProps): ReactElement {
    const sessionState = sessionStore((state) => state.state);
    const entries = sessionStore((state) => state.entries);
    const liveMessage = sessionStore((state) => state.liveMessage);
    const liveToolExecutions = sessionStore((state) => state.liveToolExecutions);
    const liveActivity = sessionStore((state) => state.liveActivity);
    const activityNotice = sessionStore((state) => state.activityNotice);

    const terminalStatus = status === "error" || status === "closed";
    const connectedRuntime = status === "open" || status === "reconnecting";
    const runtimeStreaming = sessionState?.isStreaming ?? null;
    const steeringMessages = sessionState?.steeringMessages ?? EMPTY_QUEUE;
    const followUpMessages = sessionState?.followUpMessages ?? EMPTY_QUEUE;
    // The runtime can still append a result while an open/reconnecting socket reports a stream or
    // message. A terminal or cached connecting session never triggers a live spinner pre-snapshot.
    const runtimeActive = connectedRuntime && (runtimeStreaming === true || liveMessage.kind === "streaming");
    const effectiveActivity: SessionLiveActivity = terminalStatus
        ? IDLE_ACTIVITY
        : liveActivity.kind !== "idle"
          ? liveActivity
          : runtimeActive
            ? WORKING_ACTIVITY
            : IDLE_ACTIVITY;
    const effectiveNotice = terminalStatus ? null : activityNotice;
    const queuedEntries = useMemo(
        () => (connectedRuntime ? collectQueuedEntries({ steeringMessages, followUpMessages }) : EMPTY_QUEUED_ENTRIES),
        [connectedRuntime, followUpMessages, steeringMessages],
    );

    const rawLiveInput = useMemo<CoalescedLiveStreamInput>(
        () => ({ liveMessage, liveToolExecutions, runtimeActive }),
        [liveMessage, liveToolExecutions, runtimeActive],
    );
    const liveInput = useFrameCoalescedValue(rawLiveInput, LIVE_STREAM_COALESCE_OPTIONS);

    // Projecting the branch walks every entry, so it must not run again for each streamed token.
    const projectedItems = useMemo(
        () => (routeMatchesStore ? projectSessionTranscript(entries) : []),
        [entries, routeMatchesStore],
    );
    // The builder keeps the rows whose entries did not change, so a streamed token re-renders only
    // the trailing turn instead of the whole list.
    const rowBuilder = useMemo(() => createTranscriptRowBuilder(), []);
    const { items, droppedLeadingEntries } = useMemo(
        () => ({
            items: rowBuilder.build(projectedItems, {
                liveMessage: liveInput.liveMessage.kind === "none" ? null : liveInput.liveMessage.message,
                runtimeActive: liveInput.runtimeActive,
                liveToolExecutions: liveInput.liveToolExecutions,
            }),
            // Read in the same memo: the flag describes the rows just built, and the next build
            // replaces it.
            droppedLeadingEntries: rowBuilder.droppedLeadingEntries,
        }),
        [liveInput, projectedItems, rowBuilder],
    );

    const hasVisibleActivity =
        entriesSync.kind !== "loading" &&
        (effectiveActivity.kind !== "idle" || effectiveNotice !== null || queuedEntries.length > 0);
    const view = selectWorkspaceView({
        routeMatchesStore,
        status,
        entriesSync,
        hasTranscript: items.length > 0 || hasVisibleActivity,
    });

    return renderStage({
        view,
        lastError,
        transcriptKey: sessionId,
        items,
        droppedLeadingEntries,
        liveActivity: effectiveActivity,
        activityNotice: effectiveNotice,
        queuedEntries,
        clearingQueue,
        onClearQueue: composerConnected ? onClearQueue : undefined,
        onOpenLink,
        onRetryEntriesSync,
    });
}

interface StageProps {
    readonly view: WorkspaceView;
    readonly lastError: string | null;
    readonly transcriptKey: string;
    readonly items: readonly TranscriptItem[];
    /** The rows of this render dropped a leading segment, so the list must hold a released reader. */
    readonly droppedLeadingEntries: boolean;
    readonly liveActivity: SessionLiveActivity;
    readonly activityNotice: SessionActivityNotice | null;
    readonly queuedEntries: readonly QueuedEntry[];
    readonly clearingQueue: boolean;
    readonly onClearQueue?: (() => void) | undefined;
    readonly onOpenLink: (href: string) => void;
    readonly onRetryEntriesSync: () => void;
}

function renderStage({
    view,
    lastError,
    transcriptKey,
    items,
    droppedLeadingEntries,
    liveActivity,
    activityNotice,
    queuedEntries,
    clearingQueue,
    onClearQueue,
    onOpenLink,
    onRetryEntriesSync,
}: StageProps): ReactElement {
    switch (view.kind) {
        case "loading":
            return (
                <div className={styles.centered}>
                    <LoadingIndicator label="Loading session" size="lg" />
                </div>
            );
        case "syncError":
            return (
                <div className={styles.centered} role="alert">
                    <h2 className={styles.title}>Cannot load the transcript</h2>
                    <p className={styles.text}>{view.message}</p>
                    <div className={styles.actions}>
                        <Button type="button" variant="secondary" onClick={onRetryEntriesSync}>
                            Retry
                        </Button>
                    </div>
                </div>
            );
        case "terminalError":
            return (
                <div className={styles.centered} role="alert">
                    <h2 className={styles.title}>{view.closed ? "Session closed" : "Connection lost"}</h2>
                    <p className={styles.text}>
                        {lastError ?? "The session connection ended before a transcript arrived."}
                    </p>
                </div>
            );
        case "empty":
            return (
                <div className={styles.centered}>
                    <h2 className={styles.title}>Empty session</h2>
                    <p className={styles.text}>This session has no messages yet.</p>
                </div>
            );
        case "transcript":
            return (
                <>
                    {view.syncError !== null ? (
                        <div className={styles.statusBar} role="alert">
                            <span className={styles.statusText}>
                                The transcript stopped syncing. New entries stay hidden until the sync succeeds.
                            </span>
                            <Button
                                type="button"
                                variant="secondary"
                                className={styles.retry}
                                onClick={onRetryEntriesSync}
                            >
                                Retry
                            </Button>
                        </div>
                    ) : null}
                    <Transcript
                        key={transcriptKey}
                        items={items}
                        droppedLeadingEntries={droppedLeadingEntries}
                        liveActivity={liveActivity}
                        activityNotice={activityNotice}
                        queuedEntries={queuedEntries}
                        onClearQueue={onClearQueue}
                        clearingQueue={clearingQueue}
                        edgeFade={false}
                        className={styles.transcript}
                        onOpenLink={onOpenLink}
                    />
                </>
            );
        default:
            return assertNever(view);
    }
}

interface PaneHeaderProps {
    readonly header?: SessionPaneHeaderProps | undefined;
    readonly runtimeReady?: boolean | undefined;
    readonly compacting?: boolean | undefined;
    readonly onShowStats?: (() => void) | undefined;
}

function PaneHeader({
    header,
    runtimeReady = false,
    compacting = false,
    onShowStats,
}: PaneHeaderProps): ReactElement | null {
    if (header === undefined) {
        return null;
    }
    return (
        <Topbar
            session={header.session}
            sidebarOpen={header.sidebarOpen}
            showSidebarToggle={header.showSidebarToggle}
            headingLevel={header.headingLevel}
            focused={header.focused}
            paneCount={header.paneCount}
            closing={header.closing}
            compacting={header.compacting || compacting}
            runtimeReady={runtimeReady}
            draggable={header.draggable}
            onDragStart={header.onDragStart}
            onDragEnd={header.onDragEnd}
            onToggleSidebar={header.onToggleSidebar}
            onCopySessionId={header.onCopySessionId}
            onDetachSession={header.onDetachSession}
            onShowStats={onShowStats}
            onRenameSession={header.onRenameSession}
            onCompactSession={header.onCompactSession}
            onClosePane={header.onClosePane}
        />
    );
}

interface ConnectedSessionBodyProps {
    readonly sessionId: SessionId;
    readonly sessionStore: SessionStoreInstance;
    readonly header?: SessionPaneHeaderProps | undefined;
    readonly onFocus?: (() => void) | undefined;
    readonly onOpenLink: (href: string) => void;
}

function ConnectedSessionBody({
    sessionId,
    sessionStore,
    header,
    onFocus,
    onOpenLink,
}: ConnectedSessionBodyProps): ReactElement {
    const [clearingQueue, setClearingQueue] = useState(false);

    const status = sessionStore((state) => state.status);
    const activeSessionId = sessionStore((state) => state.sessionId);
    const sessionState = sessionStore((state) => state.state);
    const entries = sessionStore((state) => state.entries);
    const entriesSync = sessionStore((state) => state.entriesSync);
    const lastError = sessionStore((state) => state.lastError);
    const retryEntriesSync = sessionStore((state) => state.retryEntriesSync);
    const sendCommand = sessionStore((state) => state.sendCommand);
    const pendingUiRequests = sessionStore((state) => state.pendingUiRequests);
    const sendUiResponse = sessionStore((state) => state.sendUiResponse);
    const notices = sessionStore((state) => state.notices);
    const dismissNotices = sessionStore((state) => state.dismissNotices);
    const editorTextRequest = sessionStore((state) => state.editorTextRequest);
    const acknowledgeEditorText = sessionStore((state) => state.acknowledgeEditorText);
    const uiState = sessionStore((state) => state.uiState);

    const routeMatchesStore = activeSessionId === sessionId;
    const scopedNotices = routeMatchesStore ? notices : EMPTY_NOTICES;
    const scopedPendingUiRequests = routeMatchesStore ? pendingUiRequests : EMPTY_UI_REQUESTS;
    const scopedUiState = routeMatchesStore ? uiState : EMPTY_SESSION_UI_STATE;
    const scopedEditorTextRequest = routeMatchesStore ? editorTextRequest : null;

    useEffect(() => {
        if (scopedNotices.length === 0) {
            return;
        }
        for (const notice of scopedNotices) {
            reportNotice(notice);
        }
        dismissNotices(scopedNotices.map((notice) => notice.id));
    }, [dismissNotices, scopedNotices]);

    const [statsOpen, setStatsOpen] = useState(false);
    const [promptMinimized, setPromptMinimized] = useState(false);
    const [answeringPromptId, setAnsweringPromptId] = useState<string | null>(null);
    const [promptError, setPromptError] = useState<string | null>(null);

    const prompt = scopedPendingUiRequests[0];
    const promptId = prompt?.id;
    const promptIdRef = useRef(promptId);
    const paneFocused = header?.focused ?? true;

    // A new request opens on top of the last one, so an answer is never left hidden by a minimize.
    const [promptTrackedId, setPromptTrackedId] = useState<string | undefined>(promptId);
    if (promptTrackedId !== promptId) {
        setPromptTrackedId(promptId);
        setPromptMinimized(false);
        setAnsweringPromptId(null);
        setPromptError(null);
    }
    if (answeringPromptId !== null && status !== "open") {
        setAnsweringPromptId(null);
    }

    useEffect(() => {
        promptIdRef.current = promptId;
    }, [promptId]);

    // Only the focused pane owns the window title; an unfocused pane must not overwrite it.
    useEffect(() => {
        if (!paneFocused || scopedUiState.title === null) {
            return undefined;
        }
        const previous = document.title;
        document.title = scopedUiState.title;
        return () => {
            document.title = previous;
        };
    }, [paneFocused, scopedUiState.title]);

    const handlePromptReply = (reply: RpcExtensionUIResponse): void => {
        if (prompt === undefined || answeringPromptId === prompt.id) {
            return;
        }
        const requestId = prompt.id;
        setAnsweringPromptId(requestId);
        setPromptError(null);
        void sendUiResponse(reply).catch((error: unknown) => {
            setAnsweringPromptId((current) => (current === requestId ? null : current));
            if (promptIdRef.current === requestId) {
                setPromptError(error instanceof Error ? error.message : String(error));
            }
        });
    };

    const composerConnected = routeMatchesStore && status === "open";

    const handleNotify = useCallback(
        (notice: { readonly tone: "info" | "warning" | "error"; readonly message: string }) => {
            if (notice.tone === "error") {
                pushToast("composer-error", "error", "Composer error", notice.message);
                return;
            }
            pushToast(`composer-${notice.tone}`, notice.tone, notice.message);
        },
        [],
    );

    const handleClearQueue = useCallback(() => {
        if (!composerConnected || clearingQueue) {
            return;
        }
        setClearingQueue(true);
        void sendCommand({ type: "clear_queue" })
            .then((response) => {
                if (!response.success) {
                    showError({ id: "clear-queue", title: "Cannot clear queue", description: response.error });
                }
            })
            .catch((error: unknown) => {
                showError({
                    id: "clear-queue",
                    title: "Cannot clear queue",
                    description: error instanceof Error ? error.message : String(error),
                });
            })
            .finally(() => {
                setClearingQueue(false);
            });
    }, [clearingQueue, composerConnected, sendCommand]);

    return (
        <section
            className={styles.pane}
            aria-label={header?.session?.title ?? "Session"}
            onPointerDownCapture={onFocus}
            onFocusCapture={onFocus}
        >
            <PaneHeader
                header={header}
                runtimeReady={composerConnected}
                compacting={routeMatchesStore && sessionState?.isCompacting === true}
                onShowStats={() => {
                    setStatsOpen(true);
                }}
            />
            <div className={styles.stage}>
                <ConnectedTranscriptStage
                    key={sessionId}
                    sessionId={sessionId}
                    sessionStore={sessionStore}
                    routeMatchesStore={routeMatchesStore}
                    status={status}
                    entriesSync={entriesSync}
                    lastError={lastError}
                    composerConnected={composerConnected}
                    onClearQueue={composerConnected ? handleClearQueue : undefined}
                    clearingQueue={clearingQueue}
                    onOpenLink={onOpenLink}
                    onRetryEntriesSync={retryEntriesSync}
                />
            </div>
            <div className={styles.composerBand}>
                <div className={styles.composerFade} aria-hidden="true" />
                <div className={styles.composerColumn}>
                    <ExtensionUiChrome uiState={scopedUiState} placement="above" />
                    <Composer
                        key={sessionId}
                        sessionId={sessionId}
                        state={routeMatchesStore ? sessionState : null}
                        connected={composerConnected}
                        extensionPrompt={
                            scopedPendingUiRequests.length === 0
                                ? undefined
                                : {
                                      count: scopedPendingUiRequests.length,
                                      reason: "Waiting for an extension answer.",
                                      onOpen: () => {
                                          setPromptMinimized(false);
                                      },
                                  }
                        }
                        editorTextRequest={scopedEditorTextRequest ?? undefined}
                        onEditorTextApplied={acknowledgeEditorText}
                        onSendCommand={sendCommand}
                        onNotify={handleNotify}
                    />
                    <ExtensionUiChrome uiState={scopedUiState} placement="below" />
                    <SessionStatusBar state={routeMatchesStore ? sessionState : null} entries={entries} />
                </div>
            </div>
            <SessionStatsDialog
                open={statsOpen}
                onOpenChange={setStatsOpen}
                state={routeMatchesStore ? sessionState : null}
                entries={entries}
            />
            {prompt !== undefined ? (
                <ExtensionUiPrompt
                    key={prompt.id}
                    open={paneFocused && !promptMinimized}
                    request={prompt}
                    pending={answeringPromptId === prompt.id || status !== "open"}
                    error={promptError}
                    onReply={handlePromptReply}
                    onMinimize={() => {
                        setPromptMinimized(true);
                    }}
                />
            ) : null}
        </section>
    );
}

/**
 * Renders one workspace session pane (header, transcript stage, and bottom composer).
 *
 * Used inside {@link SplitWorkspace} for multi-pane layouts and by standalone {@link WorkspacePage}.
 */
function SessionPaneInner({ target, sessionStore, header, onFocus, onOpenLink }: SessionPaneProps): ReactElement {
    useEffect(() => {
        if (target.kind === "invalid") {
            void ensureFontRole("mono");
        }
    }, [target.kind]);

    if (target.kind === "invalid") {
        return (
            <section
                className={styles.pane}
                aria-label="Unknown session"
                onPointerDownCapture={onFocus}
                onFocusCapture={onFocus}
            >
                <PaneHeader header={header} />
                <div className={styles.stage}>
                    <div className={styles.centered}>
                        <h2 className={styles.title}>Unknown session</h2>
                        <p className={styles.text}>
                            This session address is not valid. Choose a session from the workspace sidebar.
                        </p>
                        <code className={styles.id}>{target.raw}</code>
                    </div>
                </div>
            </section>
        );
    }

    if (target.kind === "empty") {
        return (
            <section
                className={styles.pane}
                aria-label="No session selected"
                onPointerDownCapture={onFocus}
                onFocusCapture={onFocus}
            >
                <PaneHeader header={header} />
                <div className={styles.stage}>
                    <div className={styles.centered}>
                        <h2 className={styles.title}>No session selected</h2>
                        <p className={styles.text}>
                            Choose a session from the workspace sidebar. Its transcript opens here.
                        </p>
                    </div>
                </div>
            </section>
        );
    }

    if (sessionStore === null) {
        return (
            <section
                className={styles.pane}
                aria-label={header?.session?.title ?? "Loading session"}
                onPointerDownCapture={onFocus}
                onFocusCapture={onFocus}
            >
                <PaneHeader header={header} />
                <div className={styles.stage}>
                    <div className={styles.centered}>
                        <LoadingIndicator label="Loading session" size="lg" />
                    </div>
                </div>
            </section>
        );
    }

    return (
        <ConnectedSessionBody
            key={target.sessionId}
            sessionId={target.sessionId}
            sessionStore={sessionStore}
            header={header}
            onFocus={onFocus}
            onOpenLink={onOpenLink}
        />
    );
}

/**
 * Renders one workspace session pane (header, transcript stage, and bottom composer).
 *
 * Used inside {@link SplitWorkspace} for multi-pane layouts and by standalone {@link WorkspacePage}.
 */
export const SessionPane = memo(SessionPaneInner);
