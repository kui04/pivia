import type { EntriesSyncState, SessionConnectionStatus } from "@/stores/session/store";

/**
 * What the routed chat column shows in one render.
 *
 * The view is derived from store state instead of rendered conditionally in the page, so the order
 * of the states stays testable without a browser.
 */
export type WorkspaceView =
    | { readonly kind: "loading" }
    | { readonly kind: "syncError"; readonly message: string }
    | { readonly kind: "terminalError"; readonly closed: boolean }
    | { readonly kind: "empty" }
    | { readonly kind: "transcript"; readonly syncError: string | null };

/** Inputs of {@link selectWorkspaceView}. */
export interface WorkspaceViewInput {
    /** True when the store already holds the routed session. */
    readonly routeMatchesStore: boolean;
    readonly status: SessionConnectionStatus;
    readonly entriesSync: EntriesSyncState;
    /** True when the projected transcript has at least one row. */
    readonly hasTranscript: boolean;
    /** True once the first snapshot assigned a cursor. */
    readonly hasSnapshot: boolean;
}

/**
 * Pick the page state for the current store and route.
 *
 * A store that still describes another session reports `loading`: the connect effect runs after
 * render, and showing the previous session's terminal state or sync error under the new title
 * would be a lie. A failed entry sync keeps a transcript that has rows and replaces only the
 * missing one.
 *
 * @param input - Route match, connection status, entry sync state and transcript availability.
 * @returns The state to render.
 */
export function selectWorkspaceView(input: WorkspaceViewInput): WorkspaceView {
    if (!input.routeMatchesStore) {
        return { kind: "loading" };
    }

    const terminal = input.status === "error" || input.status === "closed";
    const awaitingConnection = input.status === "idle" || input.status === "connecting";
    // An open socket without a cursor has not received its first snapshot yet, so it has nothing
    // to show and must not claim the session is empty.
    const loading =
        !terminal &&
        !input.hasTranscript &&
        (awaitingConnection || !input.hasSnapshot || input.entriesSync.kind === "loading");
    if (loading) {
        return { kind: "loading" };
    }

    if (terminal) {
        // A closed session cannot sync again, so a retryable banner would only offer a dead action.
        return input.hasTranscript
            ? { kind: "transcript", syncError: null }
            : { kind: "terminalError", closed: input.status === "closed" };
    }

    if (input.entriesSync.kind === "error") {
        return input.hasTranscript
            ? { kind: "transcript", syncError: input.entriesSync.message }
            : { kind: "syncError", message: input.entriesSync.message };
    }

    return input.hasTranscript ? { kind: "transcript", syncError: null } : { kind: "empty" };
}
