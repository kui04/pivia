import { describe, expect, it } from "vitest";

import { sid } from "@/test/ids";

import {
    clampSplitRatio,
    closePane,
    createInitialSplitLayout,
    createPaneId,
    createSplitId,
    detachSessionFromLayout,
    dockPaneAtPane,
    dockSessionAtPane,
    findLeafPane,
    findPaneBySessionId,
    focusPane,
    listLeafPanes,
    loadWorkspaceSplitLayout,
    MAX_SPLIT_RATIO,
    MAX_WORKSPACE_PANES,
    MIN_SPLIT_RATIO,
    openSessionInFocusedPane,
    openSessionInSplit,
    parsePaneId,
    parseSplitId,
    parseWorkspaceSplitLayout,
    pruneMissingSessions,
    resizeSplit,
    saveWorkspaceSplitLayout,
    serializeWorkspaceSplitLayout,
    splitPane,
    syncLayoutWithRoute,
    WORKSPACE_SPLIT_STORAGE_KEY,
    type PaneId,
    type SplitBranch,
    type SplitId,
    type SplitTreeNode,
} from "./splitLayout";

const S1 = sid("session-1");
const S2 = sid("session-2");
const S3 = sid("session-3");

function collectLayoutSessionIds(root: SplitTreeNode): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const leaf of listLeafPanes(root)) {
        if (leaf.data.kind === "session") {
            ids.add(leaf.data.sessionId);
        }
    }
    return ids;
}

function createMemoryStorage(initial: Readonly<Record<string, string>> = {}): Storage {
    const entries = new Map<string, string>(Object.entries(initial));
    return {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key) {
            return entries.get(key) ?? null;
        },
        key(index) {
            return [...entries.keys()][index] ?? null;
        },
        removeItem(key) {
            entries.delete(key);
        },
        setItem(key, value) {
            entries.set(key, value);
        },
    };
}

function mustPaneId(raw: string): PaneId {
    const parsed = parsePaneId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test pane id: ${raw}`);
    }
    return parsed;
}

function mustSplitId(raw: string): SplitId {
    const parsed = parseSplitId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test split id: ${raw}`);
    }
    return parsed;
}

describe("smart constructors and boundary parsers", () => {
    it("parsePaneId accepts safe non-empty IDs and rejects invalid or unsafe inputs", () => {
        expect(parsePaneId("pane-1")).toBe("pane-1");
        expect(parsePaneId("p_1.main")).toBe("p_1.main");
        const generated = createPaneId();
        expect(parsePaneId(generated)).toBe(generated);

        for (const bad of [
            null,
            undefined,
            123,
            {},
            "",
            "   ",
            "pane 1",
            "../pane",
            "pane/1",
            "pane\\1",
            "pane\n1",
            "p".repeat(257),
        ]) {
            expect(parsePaneId(bad)).toBeNull();
        }
    });

    it("parseSplitId accepts safe non-empty IDs and rejects invalid or unsafe inputs", () => {
        expect(parseSplitId("split-1")).toBe("split-1");
        expect(parseSplitId("s_1.root")).toBe("s_1.root");
        const generated = createSplitId();
        expect(parseSplitId(generated)).toBe(generated);

        for (const bad of [
            null,
            undefined,
            42,
            [],
            "",
            "   ",
            "split 1",
            "../split",
            "split/1",
            "split\\1",
            "split\t1",
            "s".repeat(257),
        ]) {
            expect(parseSplitId(bad)).toBeNull();
        }
    });

    it("createPaneId and createSplitId produce distinct IDs across calls", () => {
        expect(createPaneId()).not.toBe(createPaneId());
        expect(createSplitId()).not.toBe(createSplitId());
    });

    it("clampSplitRatio enforces [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] and maps non-finite values to 0.5", () => {
        expect(MIN_SPLIT_RATIO).toBe(0.15);
        expect(MAX_SPLIT_RATIO).toBe(0.85);

        expect(clampSplitRatio(-1)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(0)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(0.14)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(MIN_SPLIT_RATIO)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(0.35)).toBe(0.35);
        expect(clampSplitRatio(0.5)).toBe(0.5);
        expect(clampSplitRatio(MAX_SPLIT_RATIO)).toBe(MAX_SPLIT_RATIO);
        expect(clampSplitRatio(0.86)).toBe(MAX_SPLIT_RATIO);
        expect(clampSplitRatio(1)).toBe(MAX_SPLIT_RATIO);
        expect(clampSplitRatio(2)).toBe(MAX_SPLIT_RATIO);

        expect(clampSplitRatio(Number.NaN)).toBe(0.5);
        expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
        expect(clampSplitRatio(Number.NEGATIVE_INFINITY)).toBe(0.5);
    });
});

describe("tree queries and basic layout creation", () => {
    it("createInitialSplitLayout creates a single focused leaf pane", () => {
        const emptyLayout = createInitialSplitLayout();
        expect(emptyLayout.root.kind).toBe("leaf");
        expect(emptyLayout.root.id).toBe(emptyLayout.focusedPaneId);
        if (emptyLayout.root.kind === "leaf") {
            expect(emptyLayout.root.data).toEqual({ kind: "empty" });
        }

        const sessionLayout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        expect(sessionLayout.root.kind).toBe("leaf");
        if (sessionLayout.root.kind === "leaf") {
            expect(sessionLayout.root.data).toEqual({ kind: "session", sessionId: S1 });
            expect(sessionLayout.focusedPaneId).toBe(sessionLayout.root.id);
        }
    });

    it("lists leaves in visual depth-first order and queries by paneId or sessionId", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const firstPaneId = layout.focusedPaneId;
        layout = splitPane(layout, firstPaneId, "row", { kind: "session", sessionId: S2 });
        const secondPaneId = layout.focusedPaneId;
        layout = splitPane(layout, firstPaneId, "column", { kind: "empty" });
        const thirdPaneId = layout.focusedPaneId;

        const leaves = listLeafPanes(layout.root);
        expect(leaves.map((leaf) => leaf.id)).toEqual([firstPaneId, thirdPaneId, secondPaneId]);

        expect(findLeafPane(layout.root, thirdPaneId)?.id).toBe(thirdPaneId);
        expect(findLeafPane(layout.root, mustPaneId("missing-pane"))).toBeNull();

        expect(findPaneBySessionId(layout.root, S2)?.id).toBe(secondPaneId);
        expect(findPaneBySessionId(layout.root, S3)).toBeNull();
        expect(collectLayoutSessionIds(layout.root)).toEqual(new Set([S1, S2]));
    });
});

describe("tree mutations", () => {
    it("focusPane updates focusedPaneId for an existing pane and ignores unknown IDs", () => {
        const initial = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const firstId = initial.focusedPaneId;
        const twoPane = splitPane(initial, firstId, "row", { kind: "session", sessionId: S2 });
        const secondId = twoPane.focusedPaneId;

        const focusedFirst = focusPane(twoPane, firstId);
        expect(focusedFirst.focusedPaneId).toBe(firstId);

        const unchanged = focusPane(focusedFirst, mustPaneId("unknown-pane"));
        expect(unchanged).toEqual(focusedFirst);
        expect(unchanged.focusedPaneId).not.toBe(secondId);
    });

    it("splitPane splits along row or column with 0.5 ratio, focuses new pane, and enforces MAX_WORKSPACE_PANES", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const originalPaneId = layout.focusedPaneId;

        layout = splitPane(layout, originalPaneId, "row", { kind: "session", sessionId: S2 });
        expect(layout.root.kind).toBe("split");
        if (layout.root.kind === "split") {
            expect(layout.root.axis).toBe("row");
            expect(layout.root.ratio).toBe(0.5);
            expect(layout.root.first).toEqual({
                kind: "leaf",
                id: originalPaneId,
                data: { kind: "session", sessionId: S1 },
            });
            expect(layout.root.second.kind).toBe("leaf");
            expect(layout.focusedPaneId).toBe(layout.root.second.id);
        }

        // Requesting a split with a session already displayed focuses that existing pane instead
        // of silently creating an empty split.
        const focusedExisting = splitPane(layout, layout.focusedPaneId, "column", {
            kind: "session",
            sessionId: S1,
        });
        expect(listLeafPanes(focusedExisting.root)).toHaveLength(2);
        expect(focusedExisting.focusedPaneId).toBe(originalPaneId);

        // Splitting an unknown pane is a no-op.
        expect(splitPane(layout, mustPaneId("missing-pane"), "column")).toEqual(layout);

        // Grow up to MAX_WORKSPACE_PANES (8), then confirm a 9th split is refused.
        while (listLeafPanes(layout.root).length < MAX_WORKSPACE_PANES) {
            layout = splitPane(layout, layout.focusedPaneId, "column");
        }
        expect(listLeafPanes(layout.root)).toHaveLength(MAX_WORKSPACE_PANES);

        const atLimit = splitPane(layout, layout.focusedPaneId, "row");
        expect(listLeafPanes(atLimit.root)).toHaveLength(MAX_WORKSPACE_PANES);
        expect(atLimit).toEqual(layout);
    });

    it("closePane collapses parent split into surviving sibling, updates focus if needed, and resets sole pane to empty", () => {
        const initial = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = initial.focusedPaneId;
        const twoPane = splitPane(initial, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = twoPane.focusedPaneId;

        // Closing focused pane2 collapses back to pane1 as the root leaf and moves focus to pane1.
        const collapsed = closePane(twoPane, pane2);
        expect(collapsed.root).toEqual({
            kind: "leaf",
            id: pane1,
            data: { kind: "session", sessionId: S1 },
        });
        expect(collapsed.focusedPaneId).toBe(pane1);

        // Closing an unfocused pane keeps focus on the surviving focused pane.
        const threePane = splitPane(twoPane, pane2, "column", { kind: "session", sessionId: S3 });
        const pane3 = threePane.focusedPaneId;
        const withoutPane1 = closePane(threePane, pane1);
        expect(withoutPane1.focusedPaneId).toBe(pane3);
        expect(listLeafPanes(withoutPane1.root).map((p) => p.id)).toEqual([pane2, pane3]);

        // Closing the sole remaining leaf resets its data to empty instead of removing the leaf.
        const soleReset = closePane(collapsed, pane1);
        expect(soleReset.root).toEqual({
            kind: "leaf",
            id: pane1,
            data: { kind: "empty" },
        });
        expect(soleReset.focusedPaneId).toBe(pane1);

        // Closing an unknown pane is a no-op.
        expect(closePane(threePane, mustPaneId("missing-pane"))).toEqual(threePane);
    });

    it("resizeSplit clamps ratios on the targeted split without touching siblings", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const p1 = layout.focusedPaneId;
        layout = splitPane(layout, p1, "row", { kind: "session", sessionId: S2 });
        const p2 = layout.focusedPaneId;
        layout = splitPane(layout, p2, "column", { kind: "session", sessionId: S3 });

        const rootSplit = layout.root as SplitBranch;
        const nestedSplit = rootSplit.second as SplitBranch;

        const resized = resizeSplit(layout, rootSplit.id, 0.99);
        const resizedRoot = resized.root as SplitBranch;
        const untouchedNested = resizedRoot.second as SplitBranch;
        expect(resizedRoot.ratio).toBe(MAX_SPLIT_RATIO);
        expect(untouchedNested.ratio).toBe(nestedSplit.ratio);

        const clampedLow = resizeSplit(resized, nestedSplit.id, 0.01);
        expect((clampedLow.root as SplitBranch).second).toMatchObject({ ratio: MIN_SPLIT_RATIO });

        // Unknown splitId is a no-op.
        expect(resizeSplit(layout, mustSplitId("missing-split"), 0.4)).toEqual(layout);
    });
});

describe("session and route coordination", () => {
    it("openSessionInFocusedPane opens in focused pane or focuses existing pane without duplicating", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "empty" });
        const pane2 = layout.focusedPaneId;

        // S1 is already in pane1; opening S1 moves focus back to pane1 instead of putting S1 into pane2.
        const focusedExisting = openSessionInFocusedPane(layout, S1);
        expect(focusedExisting.focusedPaneId).toBe(pane1);
        expect(findLeafPane(focusedExisting.root, pane2)?.data).toEqual({ kind: "empty" });

        // Opening S2 (not present anywhere) replaces focused pane1's data with S2.
        const openedNew = openSessionInFocusedPane(focusedExisting, S2);
        expect(openedNew.focusedPaneId).toBe(pane1);
        expect(findLeafPane(openedNew.root, pane1)?.data).toEqual({ kind: "session", sessionId: S2 });
    });

    it("openSessionInSplit focuses existing pane, fills an empty focused pane, or splits non-empty focused pane", () => {
        // Empty focused pane is filled in place without splitting.
        const emptyLayout = createInitialSplitLayout();
        const filled = openSessionInSplit(emptyLayout, S1, "row");
        expect(listLeafPanes(filled.root)).toHaveLength(1);
        expect(findPaneBySessionId(filled.root, S1)?.id).toBe(filled.focusedPaneId);

        // Non-empty focused pane splits along axis and focuses the new pane.
        const split = openSessionInSplit(filled, S2, "column");
        expect(listLeafPanes(split.root)).toHaveLength(2);
        expect(split.root.kind).toBe("split");
        if (split.root.kind === "split") {
            expect(split.root.axis).toBe("column");
        }
        const pane2 = split.focusedPaneId;
        expect(findLeafPane(split.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });

        // Existing session is focused instead of creating a duplicate split.
        const focusedFirst = focusPane(split, filled.focusedPaneId);
        const deduped = openSessionInSplit(focusedFirst, S2, "row");
        expect(listLeafPanes(deduped.root)).toHaveLength(2);
        expect(deduped.focusedPaneId).toBe(pane2);
    });

    it("syncLayoutWithRoute handles session, invalid, and none routes while keeping focus valid and avoiding duplicates", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "empty" });
        const pane2 = layout.focusedPaneId;

        // Routing to S1 focuses existing pane1 rather than duplicating S1 into pane2.
        const routedExisting = syncLayoutWithRoute(layout, { kind: "session", sessionId: S1 });
        expect(routedExisting.focusedPaneId).toBe(pane1);
        expect(findLeafPane(routedExisting.root, pane2)?.data).toEqual({ kind: "empty" });

        // Routing to S2 opens it in the focused pane.
        const routedNew = syncLayoutWithRoute(focusPane(routedExisting, pane2), { kind: "session", sessionId: S2 });
        expect(findLeafPane(routedNew.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });
        expect(collectLayoutSessionIds(routedNew.root)).toEqual(new Set([S1, S2]));

        // Invalid route records invalid target on the focused pane while keeping focusedPaneId valid.
        const routedInvalid = syncLayoutWithRoute(routedNew, { kind: "invalid", raw: "../bad" });
        expect(findLeafPane(routedInvalid.root, routedInvalid.focusedPaneId)?.data).toEqual({
            kind: "invalid",
            raw: "../bad",
        });

        // None route preserves valid focus and session uniqueness.
        const routedNone = syncLayoutWithRoute(createInitialSplitLayout(), { kind: "none" });
        expect(findLeafPane(routedNone.root, routedNone.focusedPaneId)).not.toBeNull();
        expect(findLeafPane(routedNone.root, routedNone.focusedPaneId)?.data).toEqual({ kind: "empty" });
    });

    it("pruneMissingSessions resets deleted session panes to empty and keeps surviving sessions", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;
        layout = splitPane(layout, pane2, "column", { kind: "invalid", raw: "bad" });
        const pane3 = layout.focusedPaneId;

        const pruned = pruneMissingSessions(layout, new Set([S2]));

        expect(findLeafPane(pruned.root, pane1)?.data).toEqual({ kind: "empty" });
        expect(findLeafPane(pruned.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });
        expect(findLeafPane(pruned.root, pane3)?.data).toEqual({ kind: "invalid", raw: "bad" });
        expect(findLeafPane(pruned.root, pruned.focusedPaneId)).not.toBeNull();
    });

    it("detachSessionFromLayout clears only the target session pane while preserving split slots", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;

        const detached = detachSessionFromLayout(layout, S1);

        expect(findLeafPane(detached.root, pane1)?.data).toEqual({ kind: "empty" });
        expect(findLeafPane(detached.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });
        expect(listLeafPanes(detached.root)).toHaveLength(2);
        expect(detachSessionFromLayout(detached, S1)).toBe(detached);
    });
});

describe("persistence parsing, serialization, and storage wrappers", () => {
    it("round-trips a multi-pane layout through serializeWorkspaceSplitLayout and parseWorkspaceSplitLayout", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const p1 = layout.focusedPaneId;
        layout = splitPane(layout, p1, "row", { kind: "session", sessionId: S2 });
        const p2 = layout.focusedPaneId;
        layout = splitPane(layout, p2, "column", { kind: "invalid", raw: "bad-id" });
        const rootSplitId = (layout.root as SplitBranch).id;
        layout = resizeSplit(layout, rootSplitId, 0.32);

        const serialized = serializeWorkspaceSplitLayout(layout);
        const parsed = parseWorkspaceSplitLayout(JSON.parse(serialized) as unknown);

        expect(parsed).toEqual(layout);
    });

    it("rejects malformed or overlong layout payloads", () => {
        const validLeaf = { kind: "leaf", id: "pane-1", data: { kind: "empty" } };
        const badPayloads: unknown[] = [
            null,
            undefined,
            "not-an-object",
            42,
            [],
            {},
            { focusedPaneId: "pane-1" },
            { root: null, focusedPaneId: "pane-1" },
            { root: { kind: "unknown", id: "pane-1" }, focusedPaneId: "pane-1" },
            { root: { kind: "leaf", id: "../unsafe", data: { kind: "empty" } }, focusedPaneId: "pane-1" },
            { root: { kind: "leaf", id: "pane-1", data: { kind: "unknown" } }, focusedPaneId: "pane-1" },
            {
                root: { kind: "leaf", id: "pane-1", data: { kind: "invalid", raw: "" } },
                focusedPaneId: "pane-1",
            },
            {
                root: { kind: "leaf", id: "pane-1", data: { kind: "invalid", raw: "x".repeat(257) } },
                focusedPaneId: "pane-1",
            },
            {
                root: { kind: "leaf", id: "pane-1", data: { kind: "session", sessionId: "../bad" } },
                focusedPaneId: "pane-1",
            },
            {
                root: {
                    kind: "split",
                    id: "split-1",
                    axis: "diagonal",
                    ratio: 0.5,
                    first: validLeaf,
                    second: { kind: "leaf", id: "pane-2", target: { kind: "empty" } },
                },
                focusedPaneId: "pane-1",
            },
            {
                // 1-child split missing `second`
                root: {
                    kind: "split",
                    id: "split-1",
                    axis: "row",
                    ratio: 0.5,
                    first: validLeaf,
                },
                focusedPaneId: "pane-1",
            },
        ];

        for (const payload of badPayloads) {
            expect(parseWorkspaceSplitLayout(payload)).toBeNull();
        }

        // Rejects trees exceeding MAX_WORKSPACE_PANES (9 leaves).
        let oversized: Record<string, unknown> = { kind: "leaf", id: "pane-0", target: { kind: "empty" } };
        for (let i = 1; i <= MAX_WORKSPACE_PANES; i += 1) {
            oversized = {
                kind: "split",
                id: `split-${i}`,
                axis: "row",
                ratio: 0.5,
                first: oversized,
                second: { kind: "leaf", id: `pane-${i}`, target: { kind: "empty" } },
            };
        }
        expect(parseWorkspaceSplitLayout({ root: oversized, focusedPaneId: "pane-0" })).toBeNull();
    });

    it("normalizes missing focusedPaneId, duplicate paneIds/sessionIds, and out-of-range ratios", () => {
        const corrupted = {
            focusedPaneId: "does-not-exist",
            root: {
                kind: "split",
                id: "split-1",
                axis: "row",
                ratio: 0.02,
                first: {
                    kind: "leaf",
                    id: "dup-pane",
                    target: { kind: "session", sessionId: "session-1" },
                },
                second: {
                    kind: "split",
                    id: "split-2",
                    axis: "column",
                    ratio: 0.99,
                    first: {
                        kind: "leaf",
                        id: "dup-pane",
                        target: { kind: "session", sessionId: "session-1" },
                    },
                    second: {
                        kind: "leaf",
                        id: "pane-3",
                        target: { kind: "session", sessionId: "session-2" },
                    },
                },
            },
        };

        const parsed = parseWorkspaceSplitLayout(corrupted);
        expect(parsed).not.toBeNull();
        if (parsed === null) {
            return;
        }

        const leaves = listLeafPanes(parsed.root);
        expect(leaves).toHaveLength(3);

        // Focus falls back to a valid leaf (first leaf in visual order).
        expect(parsed.focusedPaneId).toBe(leaves[0]?.id);
        expect(findLeafPane(parsed.root, parsed.focusedPaneId)).not.toBeNull();

        // All leaf pane IDs are unique.
        expect(new Set(leaves.map((leaf) => leaf.id)).size).toBe(3);

        // Duplicate sessionId appears at most once across all leaves (legacy `target` payloads remain accepted).
        const s1Leaves = leaves.filter((leaf) => leaf.data.kind === "session" && leaf.data.sessionId === S1);
        expect(s1Leaves).toHaveLength(1);
        expect(collectLayoutSessionIds(parsed.root)).toEqual(new Set([S1, S2]));

        // Out-of-range ratios are clamped into [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO].
        const rootBranch = parsed.root as SplitBranch;
        const childBranch = rootBranch.second as SplitBranch;
        expect(rootBranch.ratio).toBe(MIN_SPLIT_RATIO);
        expect(childBranch.ratio).toBe(MAX_SPLIT_RATIO);
    });

    it("loads and saves layouts via storage and tolerates missing or throwing Storage", () => {
        const storage = createMemoryStorage();
        expect(loadWorkspaceSplitLayout(storage)).toBeNull();

        const initial = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const multi = splitPane(initial, initial.focusedPaneId, "row", { kind: "session", sessionId: S2 });

        saveWorkspaceSplitLayout(multi, storage);
        expect(storage.getItem(WORKSPACE_SPLIT_STORAGE_KEY)).not.toBeNull();
        expect(loadWorkspaceSplitLayout(storage)).toEqual(multi);

        // Corrupted JSON or invalid schema returns null cleanly.
        storage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, "{broken-json");
        expect(loadWorkspaceSplitLayout(storage)).toBeNull();
        storage.setItem(WORKSPACE_SPLIT_STORAGE_KEY, JSON.stringify({ invalid: true }));
        expect(loadWorkspaceSplitLayout(storage)).toBeNull();

        // Throwing Storage methods are tolerated without throwing.
        const throwingStorage: Pick<Storage, "getItem" | "setItem"> = {
            getItem() {
                throw new Error("SecurityError");
            },
            setItem() {
                throw new Error("QuotaExceededError");
            },
        };
        expect(loadWorkspaceSplitLayout(throwingStorage)).toBeNull();
        expect(() => {
            saveWorkspaceSplitLayout(multi, throwingStorage);
        }).not.toThrow();

        // Omitted storage in Node without localStorage does not throw.
        expect(() => loadWorkspaceSplitLayout()).not.toThrow();
        expect(() => saveWorkspaceSplitLayout(multi)).not.toThrow();
    });
});

describe("drag-and-drop docking", () => {
    it("dockSessionAtPane center opens a new session in targetPaneId and focuses it", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "empty" });
        const pane2 = layout.focusedPaneId;
        layout = focusPane(layout, pane1);

        const docked = dockSessionAtPane(layout, S2, pane2, "center");
        expect(docked.focusedPaneId).toBe(pane2);
        expect(findLeafPane(docked.root, pane1)?.data).toEqual({ kind: "session", sessionId: S1 });
        expect(findLeafPane(docked.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });
    });

    it("dockSessionAtPane center swaps targets when session is open elsewhere and target is non-empty", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;

        const docked = dockSessionAtPane(layout, S1, pane2, "center");
        expect(docked.focusedPaneId).toBe(pane2);
        expect(findLeafPane(docked.root, pane1)?.data).toEqual({ kind: "session", sessionId: S2 });
        expect(findLeafPane(docked.root, pane2)?.data).toEqual({ kind: "session", sessionId: S1 });
        expect(collectLayoutSessionIds(docked.root)).toEqual(new Set([S1, S2]));
    });

    it("dockSessionAtPane center moves session and closes source when target is empty", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "empty" });
        const pane2 = layout.focusedPaneId;
        layout = focusPane(layout, pane1);

        const docked = dockSessionAtPane(layout, S1, pane2, "center");
        expect(docked.focusedPaneId).toBe(pane2);
        expect(findLeafPane(docked.root, pane2)?.data).toEqual({ kind: "session", sessionId: S1 });
        expect(findLeafPane(docked.root, pane1)).toBeNull();
        expect(collectLayoutSessionIds(docked.root)).toEqual(new Set([S1]));
    });

    it("dockSessionAtPane center focuses targetPaneId when session is already in targetPaneId", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;

        // Focus is currently on pane2; docking S1 onto pane1 focuses pane1 without altering targets
        const docked = dockSessionAtPane(layout, S1, pane1, "center");
        expect(docked.focusedPaneId).toBe(pane1);
        expect(findLeafPane(docked.root, pane1)?.data).toEqual({ kind: "session", sessionId: S1 });
        expect(findLeafPane(docked.root, pane2)?.data).toEqual({ kind: "session", sessionId: S2 });
    });

    it("dockSessionAtPane edge zones split targetPaneId on the matching side and enforce MAX_WORKSPACE_PANES", () => {
        const cases: ReadonlyArray<{
            readonly zone: "left" | "right" | "top" | "bottom";
            readonly axis: "row" | "column";
            readonly placedFirst: boolean;
        }> = [
            { zone: "left", axis: "row", placedFirst: true },
            { zone: "right", axis: "row", placedFirst: false },
            { zone: "top", axis: "column", placedFirst: true },
            { zone: "bottom", axis: "column", placedFirst: false },
        ];

        for (const testCase of cases) {
            const initial = createInitialSplitLayout({ kind: "session", sessionId: S1 });
            const targetId = initial.focusedPaneId;

            const docked = dockSessionAtPane(initial, S2, targetId, testCase.zone);
            expect(docked.root.kind).toBe("split");
            if (docked.root.kind === "split") {
                expect(docked.root.axis).toBe(testCase.axis);
                const newLeaf = testCase.placedFirst ? docked.root.first : docked.root.second;
                const oldLeaf = testCase.placedFirst ? docked.root.second : docked.root.first;
                expect(oldLeaf.kind).toBe("leaf");
                expect(oldLeaf.id).toBe(targetId);
                expect(newLeaf.kind).toBe("leaf");
                if (newLeaf.kind === "leaf") {
                    expect(newLeaf.data).toEqual({ kind: "session", sessionId: S2 });
                    expect(docked.focusedPaneId).toBe(newLeaf.id);
                }
            }
        }

        // Enforce MAX_WORKSPACE_PANES for new sessions
        let full = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        while (listLeafPanes(full.root).length < MAX_WORKSPACE_PANES) {
            full = splitPane(full, full.focusedPaneId, "row");
        }
        expect(dockSessionAtPane(full, S2, full.focusedPaneId, "right")).toEqual(full);
    });

    it("dockSessionAtPane edge zones move an already-open session pane instead of duplicating it", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;
        layout = splitPane(layout, pane2, "column", { kind: "session", sessionId: S3 });
        const pane3 = layout.focusedPaneId;

        // S1 is in pane1; docking S1 onto pane3's top moves pane1 above pane3 and focuses pane1
        const docked = dockSessionAtPane(layout, S1, pane3, "top");
        expect(listLeafPanes(docked.root)).toHaveLength(3);
        expect(docked.focusedPaneId).toBe(pane1);
        expect(findPaneBySessionId(docked.root, S1)?.id).toBe(pane1);
        expect(listLeafPanes(docked.root).map((leaf) => leaf.id)).toEqual([pane2, pane1, pane3]);
        expect(collectLayoutSessionIds(docked.root)).toEqual(new Set([S1, S2, S3]));
    });

    it("dockSessionAtPane ignores unknown targetPaneId", () => {
        const layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const missingId = mustPaneId("missing-pane");

        expect(dockSessionAtPane(layout, S2, missingId, "center")).toEqual(layout);
        expect(dockSessionAtPane(layout, S2, missingId, "left")).toEqual(layout);
    });

    it("dockPaneAtPane center swaps source and target panes and focuses sourcePaneId", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;
        layout = splitPane(layout, pane2, "column", { kind: "session", sessionId: S3 });
        const pane3 = layout.focusedPaneId;

        const swapped = dockPaneAtPane(layout, pane1, pane3, "center");
        expect(swapped.focusedPaneId).toBe(pane1);
        expect(listLeafPanes(swapped.root).map((leaf) => leaf.id)).toEqual([pane3, pane2, pane1]);
        expect(findLeafPane(swapped.root, pane1)?.data).toEqual({ kind: "session", sessionId: S1 });
        expect(findLeafPane(swapped.root, pane3)?.data).toEqual({ kind: "session", sessionId: S3 });
    });

    it("dockPaneAtPane edge zones move sourcePaneId beside targetPaneId on the matching side and focus it", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;
        layout = splitPane(layout, pane2, "column", { kind: "session", sessionId: S3 });
        const pane3 = layout.focusedPaneId;

        // Move pane1 to the left of pane3 -> row(pane2, row(pane1, pane3))
        const movedLeft = dockPaneAtPane(layout, pane1, pane3, "left");
        expect(movedLeft.focusedPaneId).toBe(pane1);
        expect(listLeafPanes(movedLeft.root).map((leaf) => leaf.id)).toEqual([pane2, pane1, pane3]);
        const outerSplit = movedLeft.root as SplitBranch;
        expect(outerSplit.first.id).toBe(pane2);
        const innerSplit = outerSplit.second as SplitBranch;
        expect(innerSplit.axis).toBe("row");
        expect(innerSplit.first.id).toBe(pane1);
        expect(innerSplit.second.id).toBe(pane3);

        // Move pane2 to the bottom of pane1 -> column(pane1, pane2)
        const movedBottom = dockPaneAtPane(movedLeft, pane2, pane1, "bottom");
        expect(movedBottom.focusedPaneId).toBe(pane2);
        expect(listLeafPanes(movedBottom.root).map((leaf) => leaf.id)).toEqual([pane1, pane2, pane3]);
        const topSplit = movedBottom.root as SplitBranch;
        expect(topSplit.axis).toBe("row");
        const leftChild = topSplit.first as SplitBranch;
        expect(leftChild.axis).toBe("column");
        expect(leftChild.first.id).toBe(pane1);
        expect(leftChild.second.id).toBe(pane2);
    });

    it("dockPaneAtPane treats self-drop and unknown pane IDs as no-ops", () => {
        let layout = createInitialSplitLayout({ kind: "session", sessionId: S1 });
        const pane1 = layout.focusedPaneId;
        layout = splitPane(layout, pane1, "row", { kind: "session", sessionId: S2 });
        const pane2 = layout.focusedPaneId;
        const missingId = mustPaneId("missing-pane");

        expect(dockPaneAtPane(layout, pane1, pane1, "center")).toEqual(layout);
        expect(dockPaneAtPane(layout, pane1, pane1, "right")).toEqual(layout);
        expect(dockPaneAtPane(layout, missingId, pane2, "center")).toEqual(layout);
        expect(dockPaneAtPane(layout, pane1, missingId, "bottom")).toEqual(layout);
    });
});
