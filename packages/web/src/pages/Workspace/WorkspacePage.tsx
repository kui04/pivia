import { assertNever } from "@pivia/protocol";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { Button, LoadingIndicator } from "@components";
import { ensureFontRole } from "@/lib";
import { showError, showWarning, toastManager } from "@/lib/toast";
import { useSessionStore as defaultSessionStore } from "@/stores";
import {
    buildTranscript,
    projectSessionTranscript,
    type SessionActivityNotice,
    type SessionLiveActivity,
    type TranscriptItem,
} from "@/stores/session";

import { Composer } from "./components";
import { collectQueuedEntries, Transcript, type QueuedEntry } from "./components/Transcript";
import { useWorkspaceSession } from "./useWorkspaceSession";
import { selectWorkspaceView, type WorkspaceView } from "./workspaceView";
import styles from "./WorkspacePage.module.css";

/** Optional dependency injection used by page stories and isolated tests. */
export interface WorkspacePageProps {
    /** Session store to read; defaults to the app-wide store. */
    readonly sessionStore?: typeof defaultSessionStore | undefined;
    /** Forwarded to Markdown links rendered inside the transcript. */
    readonly onOpenLink?: ((href: string) => void) | undefined;
}

const IDLE_ACTIVITY: SessionLiveActivity = { kind: "idle" };
const WORKING_ACTIVITY: SessionLiveActivity = { kind: "working" };
const EMPTY_QUEUE: readonly string[] = [];
const EMPTY_QUEUED_ENTRIES: readonly QueuedEntry[] = [];

/** Open a followed link in a new tab so the session view never navigates away in place. */
function openExternalLink(href: string): void {
    window.open(href, "_blank", "noopener,noreferrer");
}

interface StageProps {
    readonly view: WorkspaceView;
    readonly lastError: string | null;
    /** Route session id; remounting the transcript resets its scroll and collapse state. */
    readonly transcriptKey: string;
    readonly items: readonly TranscriptItem[];
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

/**
 * The routed workspace column.
 *
 * Connects the session store to the route, projects the active branch with
 * `projectSessionTranscript`, and renders the transcript stage above the session composer.
 */
export function WorkspacePage(props: WorkspacePageProps = {}): ReactElement {
    const sessionStore = props.sessionStore ?? defaultSessionStore;
    const onOpenLink = props.onOpenLink ?? openExternalLink;
    const route = useWorkspaceSession({ sessionStore });

    useEffect(() => {
        if (route.kind === "invalid") {
            void ensureFontRole("mono");
        }
    }, [route.kind]);

    const [clearingQueue, setClearingQueue] = useState(false);

    const status = sessionStore((state) => state.status);
    const activeSessionId = sessionStore((state) => state.sessionId);
    const sessionState = sessionStore((state) => state.state);
    const entries = sessionStore((state) => state.entries);
    const entriesSync = sessionStore((state) => state.entriesSync);
    const liveMessage = sessionStore((state) => state.liveMessage);
    const liveToolExecutions = sessionStore((state) => state.liveToolExecutions);
    const liveActivity = sessionStore((state) => state.liveActivity);
    const activityNotice = sessionStore((state) => state.activityNotice);
    const runtimeStreaming = sessionState?.isStreaming ?? null;
    const steeringMessages = sessionState?.steeringMessages ?? EMPTY_QUEUE;
    const followUpMessages = sessionState?.followUpMessages ?? EMPTY_QUEUE;
    const lastError = sessionStore((state) => state.lastError);
    const retryEntriesSync = sessionStore((state) => state.retryEntriesSync);
    const sendCommand = sessionStore((state) => state.sendCommand);

    const routeMatchesStore = route.kind === "session" && activeSessionId === route.sessionId;
    const terminalStatus = status === "error" || status === "closed";
    const connectedRuntime = status === "open" || status === "reconnecting";
    const composerConnected = routeMatchesStore && status === "open";
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

    // Projecting the branch walks every entry, so it must not run again for each streamed token.
    const projectedItems = useMemo(
        () => (routeMatchesStore ? projectSessionTranscript(entries) : []),
        [entries, routeMatchesStore],
    );
    const items = useMemo(
        () =>
            buildTranscript(projectedItems, {
                liveMessage: liveMessage.kind === "none" ? null : liveMessage.message,
                runtimeActive,
                liveToolExecutions,
            }),
        [liveMessage, liveToolExecutions, projectedItems, runtimeActive],
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

    const handleNotify = useCallback(
        (notice: { readonly tone: "info" | "warning" | "error"; readonly message: string }) => {
            if (notice.tone === "error") {
                showError({ id: "composer-error", title: "Composer error", description: notice.message });
            } else if (notice.tone === "warning") {
                showWarning({ id: "composer-warning", title: notice.message });
            } else {
                toastManager.add({
                    id: "composer-info",
                    type: "info",
                    priority: "low",
                    title: notice.message,
                });
            }
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

    if (route.kind === "invalid") {
        return (
            <section className={styles.page} aria-label="Session">
                <div className={styles.stage}>
                    <div className={styles.centered}>
                        <h2 className={styles.title}>Unknown session</h2>
                        <p className={styles.text}>
                            This session address is not valid. Choose a session from the workspace sidebar.
                        </p>
                        <code className={styles.id}>{route.raw}</code>
                    </div>
                </div>
            </section>
        );
    }

    if (route.kind === "none") {
        return (
            <section className={styles.page} aria-label="Session">
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

    return (
        <section className={styles.page} aria-label="Session">
            <div className={styles.stage}>
                {renderStage({
                    view,
                    lastError,
                    transcriptKey: route.sessionId,
                    items,
                    liveActivity: effectiveActivity,
                    activityNotice: effectiveNotice,
                    queuedEntries,
                    clearingQueue,
                    onClearQueue: composerConnected ? handleClearQueue : undefined,
                    onOpenLink,
                    onRetryEntriesSync: retryEntriesSync,
                })}
            </div>
            <div className={styles.composerBand}>
                <div className={styles.composerFade} aria-hidden="true" />
                <div className={styles.composerColumn}>
                    <Composer
                        key={route.sessionId}
                        sessionId={route.sessionId}
                        state={routeMatchesStore ? sessionState : null}
                        connected={composerConnected}
                        onSendCommand={sendCommand}
                        onNotify={handleNotify}
                    />
                </div>
            </div>
        </section>
    );
}
