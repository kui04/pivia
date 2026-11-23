import { assertNever } from "@pivia/protocol";
import { useMemo, type ReactElement } from "react";

import { Button, LoadingIndicator } from "@components";
import { useSessionStore as defaultSessionStore } from "@/stores";
import { projectSessionTranscript } from "@/stores/session/projection";
import { buildTranscript, type TranscriptItem } from "@/stores/session/transcript";

import { Transcript } from "./components/Transcript/Transcript";
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
    readonly onOpenLink: (href: string) => void;
    readonly onRetryEntriesSync: () => void;
}

function renderStage({
    view,
    lastError,
    transcriptKey,
    items,
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
 * `projectSessionTranscript`, and renders the loading, empty, synchronization-error and transcript
 * states around it. The message composer slot stays a placeholder until the composer arrives.
 */
export function WorkspacePage(props: WorkspacePageProps = {}): ReactElement {
    const sessionStore = props.sessionStore ?? defaultSessionStore;
    const onOpenLink = props.onOpenLink ?? openExternalLink;
    const route = useWorkspaceSession({ sessionStore });

    const status = sessionStore((state) => state.status);
    const activeSessionId = sessionStore((state) => state.sessionId);
    const entries = sessionStore((state) => state.entries);
    const entriesSync = sessionStore((state) => state.entriesSync);
    const liveMessage = sessionStore((state) => state.liveMessage);
    const runtimeStreaming = sessionStore((state) => state.state?.isStreaming ?? null);
    const lastError = sessionStore((state) => state.lastError);
    const retryEntriesSync = sessionStore((state) => state.retryEntriesSync);

    const routeMatchesStore = route.kind === "session" && activeSessionId === route.sessionId;
    const terminalStatus = status === "error" || status === "closed";
    // The runtime can still append a result while the socket reports a stream or a message is
    // arriving. A terminal session never can, even if its last snapshot kept isStreaming.
    const runtimeActive = !terminalStatus && (runtimeStreaming === true || liveMessage.kind === "streaming");

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
            }),
        [liveMessage, projectedItems, runtimeActive],
    );

    const view = selectWorkspaceView({
        routeMatchesStore,
        status,
        entriesSync,
        hasTranscript: items.length > 0,
    });

    const composerArea = (
        <div className={styles.composerArea}>
            <p className={styles.composerSlot}>The message composer arrives in a later update.</p>
        </div>
    );

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
                {composerArea}
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
                {composerArea}
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
                    onOpenLink,
                    onRetryEntriesSync: retryEntriesSync,
                })}
            </div>
            {composerArea}
        </section>
    );
}
