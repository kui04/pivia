import { describe, expect, it } from "vitest";

import { selectWorkspaceView, type WorkspaceViewInput } from "./workspaceView";

const IDLE_SYNC = { kind: "idle" } as const;

function input(overrides: Partial<WorkspaceViewInput> = {}): WorkspaceViewInput {
    return {
        routeMatchesStore: true,
        status: "open",
        entriesSync: IDLE_SYNC,
        hasTranscript: false,
        ...overrides,
    };
}

describe("selectWorkspaceView", () => {
    it("reports loading while the store still describes another session", () => {
        // A terminal state or sync error from the previous session must not flash under the new route.
        for (const status of ["error", "closed", "open"] as const) {
            expect(
                selectWorkspaceView(
                    input({
                        routeMatchesStore: false,
                        status,
                        entriesSync: { kind: "error", message: "old" },
                    }),
                ),
            ).toEqual({ kind: "loading" });
        }
    });

    it("reports loading while the first snapshot is pending", () => {
        expect(selectWorkspaceView(input({ status: "idle" }))).toEqual({ kind: "loading" });
        expect(selectWorkspaceView(input({ status: "connecting" }))).toEqual({ kind: "loading" });
    });

    it("reports loading while entries hydrate", () => {
        expect(selectWorkspaceView(input({ entriesSync: { kind: "loading" } }))).toEqual({ kind: "loading" });
    });

    it("keeps the transcript and reports the sync error when rows exist", () => {
        expect(
            selectWorkspaceView(
                input({
                    hasTranscript: true,
                    entriesSync: { kind: "error", message: "Cannot read" },
                }),
            ),
        ).toEqual({ kind: "transcript", syncError: "Cannot read" });
    });

    it("replaces a missing transcript with the sync error", () => {
        expect(
            selectWorkspaceView(
                input({
                    entriesSync: { kind: "error", message: "Cannot read" },
                }),
            ),
        ).toEqual({ kind: "syncError", message: "Cannot read" });
    });

    it("reports a terminal connection state without rows and drops the entry retry", () => {
        const entriesSync = { kind: "error", message: "Cannot read" } as const;

        expect(selectWorkspaceView(input({ status: "closed" }))).toEqual({ kind: "terminalError", closed: true });
        expect(selectWorkspaceView(input({ status: "error" }))).toEqual({ kind: "terminalError", closed: false });
        expect(selectWorkspaceView(input({ status: "closed", hasTranscript: true }))).toEqual({
            kind: "transcript",
            syncError: null,
        });
        expect(selectWorkspaceView(input({ status: "closed", hasTranscript: true, entriesSync }))).toEqual({
            kind: "transcript",
            syncError: null,
        });
        expect(selectWorkspaceView(input({ status: "error", entriesSync }))).toEqual({
            kind: "terminalError",
            closed: false,
        });
    });

    it("reports an empty session once the first snapshot has no rows", () => {
        expect(selectWorkspaceView(input())).toEqual({ kind: "empty" });
    });

    it("reports the transcript when rows exist", () => {
        expect(selectWorkspaceView(input({ hasTranscript: true }))).toEqual({ kind: "transcript", syncError: null });
    });
});
