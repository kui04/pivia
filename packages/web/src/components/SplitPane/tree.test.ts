import { describe, expect, it } from "vitest";

import {
    canSplitWithinMinSize,
    clampRatioForContainer,
    clampSplitRatio,
    computeSplitRatioBounds,
    computeTreeGeometry,
    computeTreeLeafSizes,
    createPaneId,
    createSplitId,
    DEFAULT_MIN_PANE_HEIGHT_PX,
    DEFAULT_MIN_PANE_WIDTH_PX,
    DEFAULT_SPLIT_RATIO,
    findTreeLeaf,
    firstTreeLeaf,
    listTreeLeaves,
    MAX_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
    moveTreeLeaf,
    parsePaneId,
    parseSplitId,
    removeTreeLeaf,
    resizeTreeSplit,
    splitTreeNode,
    swapTreeLeaves,
    updateTreeLeafData,
    type PaneId,
    type SplitId,
    type SplitTreeBranch,
    type SplitTreeLeaf,
    type SplitTreeNode,
} from "./tree";

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

function makeLeaf<TData>(id: string, data: TData): SplitTreeLeaf<TData> {
    return {
        kind: "leaf",
        id: mustPaneId(id),
        data,
    };
}

function makeBranch<TData>(
    id: string,
    axis: "row" | "column",
    ratio: number,
    first: SplitTreeNode<TData>,
    second: SplitTreeNode<TData>,
): SplitTreeBranch<TData> {
    return {
        kind: "split",
        id: mustSplitId(id),
        axis,
        ratio: clampSplitRatio(ratio),
        first,
        second,
    };
}

describe("tree smart constructors and ratio clamping", () => {
    it("parsePaneId and parseSplitId accept safe IDs and reject invalid or unsafe inputs", () => {
        expect(parsePaneId("pane-1")).toBe("pane-1");
        expect(parseSplitId("split-1")).toBe("split-1");

        const generatedPane = createPaneId();
        const generatedSplit = createSplitId();
        expect(parsePaneId(generatedPane)).toBe(generatedPane);
        expect(parseSplitId(generatedSplit)).toBe(generatedSplit);
        expect(createPaneId()).not.toBe(createPaneId());
        expect(createSplitId()).not.toBe(createSplitId());

        for (const bad of [null, undefined, 42, "", "   ", "bad id", "../bad", "a/b", "a".repeat(257)]) {
            expect(parsePaneId(bad)).toBeNull();
            expect(parseSplitId(bad)).toBeNull();
        }
    });

    it("clampSplitRatio enforces [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] and maps non-finite values to 0.5", () => {
        expect(MIN_SPLIT_RATIO).toBe(0.15);
        expect(MAX_SPLIT_RATIO).toBe(0.85);
        expect(DEFAULT_SPLIT_RATIO).toBe(0.5);

        expect(clampSplitRatio(-1)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(0.1)).toBe(MIN_SPLIT_RATIO);
        expect(clampSplitRatio(0.42)).toBe(0.42);
        expect(clampSplitRatio(0.95)).toBe(MAX_SPLIT_RATIO);
        expect(clampSplitRatio(Number.NaN)).toBe(0.5);
        expect(clampSplitRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
        expect(clampSplitRatio(Number.NEGATIVE_INFINITY)).toBe(0.5);
    });
});

describe("tree queries, sizes, and leaf updates", () => {
    it("listTreeLeaves returns leaves in depth-first order and findTreeLeaf locates leaves by id", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");
        const tree: SplitTreeNode<string> = {
            kind: "split",
            id: "split-root" as SplitId,
            axis: "row",
            ratio: DEFAULT_SPLIT_RATIO,
            first: {
                kind: "split",
                id: "split-left" as SplitId,
                axis: "column",
                ratio: DEFAULT_SPLIT_RATIO,
                first: a,
                second: b,
            },
            second: c,
        };

        expect(listTreeLeaves(tree).map((leaf) => leaf.id)).toEqual([a.id, b.id, c.id]);
        expect(firstTreeLeaf(tree)).toEqual(a);
        expect(findTreeLeaf(tree, b.id)).toEqual(b);
        expect(findTreeLeaf(tree, "missing-pane" as PaneId)).toBeNull();
    });

    it("computeTreeGeometry derives leaf and split dimensions, ratio bounds, and min-size checks", () => {
        expect(DEFAULT_MIN_PANE_WIDTH_PX).toBe(320);
        expect(DEFAULT_MIN_PANE_HEIGHT_PX).toBe(240);

        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");
        const inner = makeBranch("split-inner", "column", 0.4, a, b);
        const root = makeBranch("split-root", "row", 0.5, inner, c);

        const geometry = computeTreeGeometry(root, 1000, 600);
        expect(geometry.splitSizes.get(root.id)).toEqual({ width: 1000, height: 600 });
        expect(geometry.splitSizes.get(inner.id)).toEqual({ width: 500, height: 600 });

        const sizes = computeTreeLeafSizes(root, 1000, 600);
        expect(sizes.get(a.id)).toEqual({ width: 500, height: 240 });
        expect(sizes.get(b.id)).toEqual({ width: 500, height: 360 });
        expect(sizes.get(c.id)).toEqual({ width: 500, height: 600 });

        // With containerWidth=1800 and minPanePx=320: min ratio = 320/1800, max = 1 - 320/1800
        const bounds = computeSplitRatioBounds(1800, 320);
        expect(bounds.min).toBeCloseTo(320 / 1800);
        expect(bounds.max).toBeCloseTo(1 - 320 / 1800);
        expect(clampRatioForContainer(0.15, 1800, 320)).toBeCloseTo(320 / 1800);
        expect(clampRatioForContainer(0.85, 1800, 320)).toBeCloseTo(1 - 320 / 1800);

        // When container <= 2 * minPanePx, bounds converge safely at 0.5 without inverting
        expect(computeSplitRatioBounds(500, 320)).toEqual({ min: 0.5, max: 0.5 });

        // With minPaneWidthPx=320 and minPaneHeightPx=240:
        // width 500 < 640 -> cannot split row; height 600 >= 480 -> can split column on C
        expect(canSplitWithinMinSize(sizes.get(c.id), "row", 320, 240)).toBe(false);
        expect(canSplitWithinMinSize(sizes.get(c.id), "column", 320, 240)).toBe(true);
        // height 240 < 480 -> cannot split column on A
        expect(canSplitWithinMinSize(sizes.get(a.id), "column", 320, 240)).toBe(false);
        // Unmeasured leaf size falls back to allowing split
        expect(canSplitWithinMinSize(undefined, "row", 320, 240)).toBe(true);
        // Non-positive container size returns empty map
        expect(computeTreeLeafSizes(root, 0, 600).size).toBe(0);
    });

    it("updateTreeLeafData updates only the targeted leaf and leaves siblings untouched", () => {
        const a = makeLeaf("pane-a", { label: "alpha" });
        const b = makeLeaf("pane-b", { label: "beta" });
        const root = splitTreeNode(a, a.id, "row", b);

        const updated = updateTreeLeafData(root, b.id, (data) => ({ label: `${data.label}-updated` }));
        expect(findTreeLeaf(updated, a.id)?.data).toEqual({ label: "alpha" });
        expect(findTreeLeaf(updated, b.id)?.data).toEqual({ label: "beta-updated" });

        // Unknown paneId is a no-op
        expect(updateTreeLeafData(root, mustPaneId("missing-pane"), () => ({ label: "x" }))).toEqual(root);
    });
});

describe("splitTreeNode and removeTreeLeaf", () => {
    it("splits a target leaf with second (default) and first placement, and ignores unknown targetPaneId", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");

        const defaultSplit = splitTreeNode(a, a.id, "row", b);
        expect(defaultSplit.kind).toBe("split");
        if (defaultSplit.kind === "split") {
            expect(defaultSplit.axis).toBe("row");
            expect(defaultSplit.ratio).toBe(DEFAULT_SPLIT_RATIO);
            expect(defaultSplit.first).toEqual(a);
            expect(defaultSplit.second).toEqual(b);
        }

        const firstSplit = splitTreeNode(defaultSplit, a.id, "column", c, "first");
        expect(listTreeLeaves(firstSplit).map((leaf) => leaf.id)).toEqual([c.id, a.id, b.id]);
        if (firstSplit.kind === "split" && firstSplit.first.kind === "split") {
            expect(firstSplit.first.axis).toBe("column");
            expect(firstSplit.first.first).toEqual(c);
            expect(firstSplit.first.second).toEqual(a);
        }

        // Unknown targetPaneId is a no-op
        expect(splitTreeNode(firstSplit, mustPaneId("missing-pane"), "row", makeLeaf("pane-d", "D"))).toEqual(
            firstSplit,
        );
    });

    it("removeTreeLeaf collapses parent splits and returns null root when removing the sole leaf", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");

        // Sole leaf removal returns null root
        expect(removeTreeLeaf(a, a.id)).toEqual({ root: null, fallbackFocusId: null });

        // Build nested tree: row(col(a, b), c)
        const twoPane = splitTreeNode(a, a.id, "row", c);
        const threePane = splitTreeNode(twoPane, a.id, "column", b);

        // Removing nested leaf `a` collapses inner split into `b` while preserving outer split
        const withoutA = removeTreeLeaf(threePane, a.id);
        expect(withoutA.root).not.toBeNull();
        expect(withoutA.fallbackFocusId).toBe(b.id);
        if (withoutA.root !== null) {
            expect(withoutA.root.kind).toBe("split");
            expect(listTreeLeaves(withoutA.root).map((leaf) => leaf.id)).toEqual([b.id, c.id]);
        }

        // Removing `c` collapses remaining split into sole leaf `b`
        if (withoutA.root !== null) {
            const withoutC = removeTreeLeaf(withoutA.root, c.id);
            expect(withoutC.root).toEqual(b);
            expect(withoutC.fallbackFocusId).toBe(b.id);
        }

        // Unknown paneId returns original tree unchanged
        expect(removeTreeLeaf(threePane, mustPaneId("missing-pane"))).toEqual({
            root: threePane,
            fallbackFocusId: null,
        });
    });
});

describe("resizeTreeSplit", () => {
    it("clamps ratios within [MIN_SPLIT_RATIO, MAX_SPLIT_RATIO] and ignores unknown splitId", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");
        const inner = makeBranch("split-inner", "column", 0.5, a, b);
        const root = makeBranch("split-root", "row", 0.5, inner, c);

        const resizedHigh = resizeTreeSplit(root, root.id, 0.99);
        expect((resizedHigh as SplitTreeBranch<string>).ratio).toBe(MAX_SPLIT_RATIO);
        expect(((resizedHigh as SplitTreeBranch<string>).first as SplitTreeBranch<string>).ratio).toBe(0.5);

        const resizedLow = resizeTreeSplit(resizedHigh, inner.id, 0.01);
        expect(((resizedLow as SplitTreeBranch<string>).first as SplitTreeBranch<string>).ratio).toBe(MIN_SPLIT_RATIO);

        expect(resizeTreeSplit(root, mustSplitId("missing-split"), 0.3)).toEqual(root);
    });
});

describe("moveTreeLeaf and swapTreeLeaves", () => {
    it("moveTreeLeaf relocates an existing leaf beside target and collapses its old parent split", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");
        // Structure: row(col(a, b) @ 0.3, c) @ 0.6
        const inner = makeBranch("split-inner", "column", 0.3, a, b);
        const root = makeBranch("split-root", "row", 0.6, inner, c);

        // Move `a` to the "first" side along "row" of `c` -> row(b, row(a, c)) @ 0.6
        const moved = moveTreeLeaf(root, a.id, c.id, "row", "first");
        expect(listTreeLeaves(moved).map((leaf) => leaf.id)).toEqual([b.id, a.id, c.id]);
        expect(findTreeLeaf(moved, a.id)?.data).toBe("A");
        expect(moved.kind).toBe("split");
        if (moved.kind === "split") {
            expect(moved.first).toEqual(b);
            expect(moved.ratio).toBe(clampSplitRatio(0.6));
            expect(moved.second.kind).toBe("split");
            if (moved.second.kind === "split") {
                expect(moved.second.axis).toBe("row");
                expect(moved.second.first).toEqual(a);
                expect(moved.second.second).toEqual(c);
            }
        }

        // Move `c` to "second" along "column" of `b` in the 2-branch tree
        const movedSecond = moveTreeLeaf(moved, c.id, b.id, "column", "second");
        expect(listTreeLeaves(movedSecond).map((leaf) => leaf.id)).toEqual([b.id, c.id, a.id]);
        if (movedSecond.kind === "split" && movedSecond.first.kind === "split") {
            expect(movedSecond.first.axis).toBe("column");
            expect(movedSecond.first.first).toEqual(b);
            expect(movedSecond.first.second).toEqual(c);
            expect(movedSecond.second).toEqual(a);
        }
    });

    it("moveTreeLeaf is a no-op when sourcePaneId === targetPaneId or either ID is missing", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const root = makeBranch("split-root", "row", 0.4, a, b);

        expect(moveTreeLeaf(root, a.id, a.id, "column", "first")).toEqual(root);
        expect(moveTreeLeaf(root, mustPaneId("missing"), b.id, "column", "first")).toEqual(root);
        expect(moveTreeLeaf(root, a.id, mustPaneId("missing"), "column", "first")).toEqual(root);
    });

    it("swapTreeLeaves swaps two leaves' positions while preserving split IDs, axes, and ratios", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const c = makeLeaf("pane-c", "C");
        const inner = makeBranch("split-inner", "column", 0.25, a, b);
        const root = makeBranch("split-root", "row", 0.7, inner, c);

        const swapped = swapTreeLeaves(root, a.id, c.id);
        expect(listTreeLeaves(swapped).map((leaf) => leaf.id)).toEqual([c.id, b.id, a.id]);
        expect(swapped.kind).toBe("split");
        if (swapped.kind === "split") {
            expect(swapped.id).toBe(root.id);
            expect(swapped.axis).toBe("row");
            expect(swapped.ratio).toBe(root.ratio);
            expect(swapped.second).toEqual(a);
            expect(swapped.first.kind).toBe("split");
            if (swapped.first.kind === "split") {
                expect(swapped.first.id).toBe(inner.id);
                expect(swapped.first.axis).toBe("column");
                expect(swapped.first.ratio).toBe(inner.ratio);
                expect(swapped.first.first).toEqual(c);
                expect(swapped.first.second).toEqual(b);
            }
        }
    });

    it("swapTreeLeaves is a no-op when aId === bId or either ID is missing", () => {
        const a = makeLeaf("pane-a", "A");
        const b = makeLeaf("pane-b", "B");
        const root = makeBranch("split-root", "row", 0.5, a, b);

        expect(swapTreeLeaves(root, a.id, a.id)).toEqual(root);
        expect(swapTreeLeaves(root, mustPaneId("missing"), b.id)).toEqual(root);
        expect(swapTreeLeaves(root, a.id, mustPaneId("missing"))).toEqual(root);
    });
});
