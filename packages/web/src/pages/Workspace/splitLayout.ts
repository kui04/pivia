import { isRecord, parseSessionId, type SessionId } from "@pivia/protocol";

import type { DropDockZone } from "@components/SplitPane/dnd";
import {
    clampSplitRatio,
    createPaneId,
    createSplitId,
    DEFAULT_MIN_PANE_HEIGHT_PX,
    DEFAULT_MIN_PANE_WIDTH_PX,
    findTreeLeaf,
    firstTreeLeaf,
    listTreeLeaves,
    MAX_ID_LENGTH,
    moveTreeLeaf,
    parsePaneId,
    parseSplitId,
    removeTreeLeaf,
    resizeTreeSplit,
    splitTreeNode,
    swapTreeLeaves,
    updateTreeLeafData,
    type PaneId,
    type SplitAxis,
    type SplitId,
    type SplitPlacement,
    type SplitTreeBranch,
    type SplitTreeLeaf,
    type SplitTreeNode as GenericSplitTreeNode,
} from "@components/SplitPane/tree";

import type { WorkspaceSessionRoute } from "./useWorkspaceSession";

export {
    clampSplitRatio,
    createPaneId,
    createSplitId,
    DEFAULT_SPLIT_RATIO,
    MAX_SPLIT_RATIO,
    MIN_SPLIT_RATIO,
    parsePaneId,
    parseSplitId,
    type PaneId,
    type SplitAxis,
    type SplitId,
    type SplitRatio,
} from "@components/SplitPane/tree";

/** Maximum number of leaf panes permitted in one workspace layout. */
export const MAX_WORKSPACE_PANES = 8;

/** Minimum usable pane width (px) enforced when splitting or resizing horizontally. */
export const MIN_PANE_WIDTH_PX = DEFAULT_MIN_PANE_WIDTH_PX;

/** Minimum usable pane height (px) enforced when splitting or resizing vertically. */
export const MIN_PANE_HEIGHT_PX = DEFAULT_MIN_PANE_HEIGHT_PX;

/** Default localStorage key for persisted split pane layouts. */
export const WORKSPACE_SPLIT_STORAGE_KEY = "pivia.workspace.layout.v1";

/** Drag-and-drop MIME keys for workspace session rows and pane headers. */
export const WORKSPACE_DRAG_MIME = {
    session: "application/x-pivia-session",
    pane: "application/x-pivia-pane",
} as const;

/** What a leaf pane displays. */
export type PaneTarget =
    | { readonly kind: "empty" }
    | { readonly kind: "session"; readonly sessionId: SessionId }
    | { readonly kind: "invalid"; readonly raw: string };

/** One terminal pane in the split tree. */
export type LeafPane = SplitTreeLeaf<PaneTarget>;

/** One binary split dividing space between two non-empty subtrees. */
export type SplitBranch = SplitTreeBranch<PaneTarget>;

/** Recursive binary tree of workspace panes; always contains at least one {@link LeafPane}. */
export type SplitTreeNode = GenericSplitTreeNode<PaneTarget>;

/**
 * Root split-pane state.
 *
 * Invariant: `focusedPaneId` always refers to a {@link LeafPane} present in `root`, and each
 * {@link SessionId} appears in at most one leaf pane (enforced by {@link setLeafTarget} /
 * {@link swapLeafTargets}).
 */
export interface WorkspaceSplitLayout {
    readonly root: SplitTreeNode;
    readonly focusedPaneId: PaneId;
}

/** Return all leaf panes in visual depth-first order (top-left to bottom-right). */
export const listLeafPanes: (root: SplitTreeNode) => readonly LeafPane[] = listTreeLeaves;

/** Find a leaf pane by id, or `null` when absent. */
export const findLeafPane: (root: SplitTreeNode, paneId: PaneId) => LeafPane | null = findTreeLeaf;

/** Create a single-pane layout holding `target` (defaults to `{ kind: "empty" }`). */
export function createInitialSplitLayout(target: PaneTarget = { kind: "empty" }): WorkspaceSplitLayout {
    const id = createPaneId();
    return {
        root: { kind: "leaf", id, data: target },
        focusedPaneId: id,
    };
}

/** Find the leaf pane displaying `sessionId`, or `null` when no pane shows it. */
export function findPaneBySessionId(root: SplitTreeNode, sessionId: SessionId): LeafPane | null {
    for (const leaf of listLeafPanes(root)) {
        if (leaf.data.kind === "session" && leaf.data.sessionId === sessionId) {
            return leaf;
        }
    }
    return null;
}

/** Single mutation choke-point that updates a leaf's target while enforcing session uniqueness. */
function setLeafTarget(root: SplitTreeNode, paneId: PaneId, nextTarget: PaneTarget): SplitTreeNode {
    if (nextTarget.kind === "session") {
        const existing = findPaneBySessionId(root, nextTarget.sessionId);
        if (existing !== null && existing.id !== paneId) {
            throw new Error(`Session ${nextTarget.sessionId} is already assigned to pane ${existing.id}`);
        }
    }
    return updateTreeLeafData(root, paneId, () => nextTarget);
}

/** Atomically swap the payloads of two distinct leaves `a` and `b` without transient session duplicates. */
function swapLeafTargets(root: SplitTreeNode, leafA: LeafPane, leafB: LeafPane): SplitTreeNode {
    if (leafA.id === leafB.id) {
        return root;
    }
    if (root.kind === "leaf") {
        if (root.id === leafA.id) {
            return { ...root, data: leafB.data };
        }
        if (root.id === leafB.id) {
            return { ...root, data: leafA.data };
        }
        return root;
    }
    const nextFirst = swapLeafTargets(root.first, leafA, leafB);
    const nextSecond = swapLeafTargets(root.second, leafA, leafB);
    return nextFirst === root.first && nextSecond === root.second
        ? root
        : { ...root, first: nextFirst, second: nextSecond };
}

/** Move focus to `paneId` if it exists in `layout`; otherwise return `layout` unchanged. */
export function focusPane(layout: WorkspaceSplitLayout, paneId: PaneId): WorkspaceSplitLayout {
    if (layout.focusedPaneId === paneId || findLeafPane(layout.root, paneId) === null) {
        return layout;
    }
    return { ...layout, focusedPaneId: paneId };
}

/**
 * Split `paneId` along `axis`, creating a new sibling leaf (default `{ kind: "empty" }`) and
 * moving focus to the new pane. Returns `layout` unchanged if `paneId` is missing or
 * {@link MAX_WORKSPACE_PANES} has been reached, and focuses the existing pane when `newTarget` is a
 * session already open elsewhere.
 */
export function splitPane(
    layout: WorkspaceSplitLayout,
    paneId: PaneId,
    axis: SplitAxis,
    newTarget: PaneTarget = { kind: "empty" },
): WorkspaceSplitLayout {
    if (findLeafPane(layout.root, paneId) === null) {
        return layout;
    }
    if (newTarget.kind === "session") {
        const existing = findPaneBySessionId(layout.root, newTarget.sessionId);
        if (existing !== null) {
            return focusPane(layout, existing.id);
        }
    }
    if (listLeafPanes(layout.root).length >= MAX_WORKSPACE_PANES) {
        return layout;
    }
    const newId = createPaneId();
    return {
        root: splitTreeNode(layout.root, paneId, axis, {
            kind: "leaf",
            id: newId,
            data: newTarget,
        }),
        focusedPaneId: newId,
    };
}

/**
 * Close `paneId`. When multiple panes exist, removes `paneId`, collapses its parent split into
 * the surviving sibling, and ensures `focusedPaneId` points to a valid leaf. When only one pane
 * exists, resets its data to `{ kind: "empty" }`.
 */
export function closePane(layout: WorkspaceSplitLayout, paneId: PaneId): WorkspaceSplitLayout {
    if (layout.root.kind === "leaf") {
        if (layout.root.id !== paneId || layout.root.data.kind === "empty") {
            return layout;
        }
        return {
            root: setLeafTarget(layout.root, layout.root.id, { kind: "empty" }),
            focusedPaneId: layout.root.id,
        };
    }
    const removed = removeTreeLeaf(layout.root, paneId);
    if (removed.root === null || removed.fallbackFocusId === null) {
        return layout;
    }
    const nextFocused =
        layout.focusedPaneId === paneId || findLeafPane(removed.root, layout.focusedPaneId) === null
            ? removed.fallbackFocusId
            : layout.focusedPaneId;
    return {
        root: removed.root,
        focusedPaneId: nextFocused,
    };
}

/** Update the ratio of `splitId` (clamped inside {@link resizeTreeSplit}). */
export function resizeSplit(layout: WorkspaceSplitLayout, splitId: SplitId, ratio: number): WorkspaceSplitLayout {
    const nextRoot = resizeTreeSplit(layout.root, splitId, ratio);
    return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
}

/**
 * Open `sessionId` from the sidebar.
 *
 * If another pane already displays `sessionId`, moves focus to that pane instead of duplicating it;
 * otherwise opens `sessionId` inside `layout.focusedPaneId`.
 */
export function openSessionInFocusedPane(layout: WorkspaceSplitLayout, sessionId: SessionId): WorkspaceSplitLayout {
    const existing = findPaneBySessionId(layout.root, sessionId);
    if (existing !== null) {
        return focusPane(layout, existing.id);
    }
    const nextRoot = setLeafTarget(layout.root, layout.focusedPaneId, { kind: "session", sessionId });
    return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
}

/**
 * Open `sessionId` in a new split alongside `layout.focusedPaneId`.
 *
 * If `sessionId` is already open in a pane, focuses that pane; if the focused pane is empty,
 * fills it instead of creating an empty sibling; otherwise splits the focused pane along `axis`.
 */
export function openSessionInSplit(
    layout: WorkspaceSplitLayout,
    sessionId: SessionId,
    axis: SplitAxis,
): WorkspaceSplitLayout {
    const existing = findPaneBySessionId(layout.root, sessionId);
    if (existing !== null) {
        return focusPane(layout, existing.id);
    }
    const focused = findLeafPane(layout.root, layout.focusedPaneId);
    if (focused !== null && focused.data.kind === "empty") {
        return openSessionInFocusedPane(layout, sessionId);
    }
    return splitPane(layout, layout.focusedPaneId, axis, { kind: "session", sessionId });
}

function zoneToSplitParams(zone: Exclude<DropDockZone, "center">): {
    readonly axis: SplitAxis;
    readonly placement: SplitPlacement;
} {
    switch (zone) {
        case "left":
            return { axis: "row", placement: "first" };
        case "right":
            return { axis: "row", placement: "second" };
        case "top":
            return { axis: "column", placement: "first" };
        case "bottom":
            return { axis: "column", placement: "second" };
    }
}

/**
 * Dock `sessionId` onto `targetPaneId` at `zone` (`"left" | "right" | "top" | "bottom" | "center"`).
 *
 * - `"center"` opens `sessionId` in `targetPaneId` (moving/closing an empty replacement or swapping
 *   when `sessionId` is already open elsewhere).
 * - Edge zones split `targetPaneId` on the matching side (moving an already-open session's pane
 *   rather than duplicating it).
 */
export function dockSessionAtPane(
    layout: WorkspaceSplitLayout,
    sessionId: SessionId,
    targetPaneId: PaneId,
    zone: DropDockZone,
): WorkspaceSplitLayout {
    const targetLeaf = findLeafPane(layout.root, targetPaneId);
    if (targetLeaf === null) {
        return layout;
    }

    const existingLeaf = findPaneBySessionId(layout.root, sessionId);
    if (zone === "center") {
        if (existingLeaf === null) {
            return {
                root: setLeafTarget(layout.root, targetPaneId, { kind: "session", sessionId }),
                focusedPaneId: targetPaneId,
            };
        }
        if (existingLeaf.id === targetPaneId) {
            return focusPane(layout, targetPaneId);
        }
        if (targetLeaf.data.kind === "empty") {
            const clearedSource = setLeafTarget(layout.root, existingLeaf.id, { kind: "empty" });
            const movedToTarget = setLeafTarget(clearedSource, targetPaneId, { kind: "session", sessionId });
            // Because existingLeaf.id !== targetPaneId, at least two leaves exist so removeTreeLeaf keeps root non-null.
            const removedSource = removeTreeLeaf(movedToTarget, existingLeaf.id);
            if (removedSource.root === null) {
                throw new Error("Expected at least two panes when moving session onto empty pane.");
            }
            return { root: removedSource.root, focusedPaneId: targetPaneId };
        }
        return {
            root: swapLeafTargets(layout.root, targetLeaf, existingLeaf),
            focusedPaneId: targetPaneId,
        };
    }

    const { axis, placement } = zoneToSplitParams(zone);
    if (existingLeaf !== null) {
        if (existingLeaf.id === targetPaneId) {
            return focusPane(layout, targetPaneId);
        }
        return {
            root: moveTreeLeaf(layout.root, existingLeaf.id, targetPaneId, axis, placement),
            focusedPaneId: existingLeaf.id,
        };
    }

    if (listLeafPanes(layout.root).length >= MAX_WORKSPACE_PANES) {
        return layout;
    }
    const newId = createPaneId();
    return {
        root: splitTreeNode(
            layout.root,
            targetPaneId,
            axis,
            { kind: "leaf", id: newId, data: { kind: "session", sessionId } },
            placement,
        ),
        focusedPaneId: newId,
    };
}

/**
 * Re-dock an existing pane `sourcePaneId` onto `targetPaneId` at `zone`.
 *
 * - `"center"` swaps `sourcePaneId` and `targetPaneId`.
 * - Edge zones move `sourcePaneId` beside `targetPaneId` along the matching axis and side.
 * - Dropping onto itself is a no-op.
 */
export function dockPaneAtPane(
    layout: WorkspaceSplitLayout,
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    zone: DropDockZone,
): WorkspaceSplitLayout {
    if (
        sourcePaneId === targetPaneId ||
        findLeafPane(layout.root, sourcePaneId) === null ||
        findLeafPane(layout.root, targetPaneId) === null
    ) {
        return layout;
    }

    if (zone === "center") {
        return {
            root: swapTreeLeaves(layout.root, sourcePaneId, targetPaneId),
            focusedPaneId: sourcePaneId,
        };
    }

    const { axis, placement } = zoneToSplitParams(zone);
    return {
        root: moveTreeLeaf(layout.root, sourcePaneId, targetPaneId, axis, placement),
        focusedPaneId: sourcePaneId,
    };
}

/** Synchronize the layout with an incoming URL route segment. */
export function syncLayoutWithRoute(layout: WorkspaceSplitLayout, route: WorkspaceSessionRoute): WorkspaceSplitLayout {
    switch (route.kind) {
        case "session":
            return openSessionInFocusedPane(layout, route.sessionId);
        case "invalid": {
            const focused = findLeafPane(layout.root, layout.focusedPaneId);
            if (focused?.data.kind === "invalid" && focused.data.raw === route.raw) {
                return layout;
            }
            const nextRoot = setLeafTarget(layout.root, layout.focusedPaneId, {
                kind: "invalid",
                raw: route.raw,
            });
            return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
        }
        case "none": {
            const focused = findLeafPane(layout.root, layout.focusedPaneId);
            if (focused === null || focused.data.kind === "empty") {
                return layout;
            }
            const nextRoot = setLeafTarget(layout.root, layout.focusedPaneId, { kind: "empty" });
            return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
        }
    }
}

function pruneNodeSessions(node: SplitTreeNode, validIds: ReadonlySet<SessionId>): SplitTreeNode {
    if (node.kind === "leaf") {
        if (node.data.kind === "session" && !validIds.has(node.data.sessionId)) {
            return { ...node, data: { kind: "empty" } };
        }
        return node;
    }
    const nextFirst = pruneNodeSessions(node.first, validIds);
    const nextSecond = pruneNodeSessions(node.second, validIds);
    if (nextFirst === node.first && nextSecond === node.second) {
        return node;
    }
    return { ...node, first: nextFirst, second: nextSecond };
}

/** Clear any pane targeting a session no longer present in `validIds` to `{ kind: "empty" }`. */
export function pruneMissingSessions(
    layout: WorkspaceSplitLayout,
    validIds: ReadonlySet<SessionId>,
): WorkspaceSplitLayout {
    const nextRoot = pruneNodeSessions(layout.root, validIds);
    return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
}

/** Reset any pane displaying `sessionId` to `{ kind: "empty" }` while keeping its split slot. */
export function detachSessionFromLayout(layout: WorkspaceSplitLayout, sessionId: SessionId): WorkspaceSplitLayout {
    const pane = findPaneBySessionId(layout.root, sessionId);
    if (pane === null) {
        return layout;
    }
    const nextRoot = setLeafTarget(layout.root, pane.id, { kind: "empty" });
    return nextRoot === layout.root ? layout : { ...layout, root: nextRoot };
}

interface ParseContext {
    readonly seenPaneIds: Set<PaneId>;
    readonly seenSplitIds: Set<SplitId>;
    readonly seenSessionIds: Set<SessionId>;
    leafCount: number;
}

function parsePaneTarget(raw: unknown, seenSessionIds: Set<SessionId>): PaneTarget | null {
    if (!isRecord(raw) || typeof raw["kind"] !== "string") {
        return null;
    }
    switch (raw["kind"]) {
        case "empty":
            return { kind: "empty" };
        case "session": {
            const sessionId = parseSessionId(raw["sessionId"]);
            if (sessionId === null) {
                return null;
            }
            if (seenSessionIds.has(sessionId)) {
                return { kind: "empty" };
            }
            seenSessionIds.add(sessionId);
            return { kind: "session", sessionId };
        }
        case "invalid":
            return typeof raw["raw"] === "string" && raw["raw"].length > 0 && raw["raw"].length <= MAX_ID_LENGTH
                ? { kind: "invalid", raw: raw["raw"] }
                : null;
        default:
            return null;
    }
}

function uniquePaneId(candidate: PaneId, seen: Set<PaneId>): PaneId {
    let next = candidate;
    while (seen.has(next)) {
        next = createPaneId();
    }
    seen.add(next);
    return next;
}

function uniqueSplitId(candidate: SplitId, seen: Set<SplitId>): SplitId {
    let next = candidate;
    while (seen.has(next)) {
        next = createSplitId();
    }
    seen.add(next);
    return next;
}

function parseSplitNode(raw: unknown, ctx: ParseContext): SplitTreeNode | null {
    if (!isRecord(raw) || typeof raw["kind"] !== "string") {
        return null;
    }
    if (raw["kind"] === "leaf") {
        ctx.leafCount += 1;
        if (ctx.leafCount > MAX_WORKSPACE_PANES) {
            return null;
        }
        const parsedId = parsePaneId(raw["id"]);
        if (parsedId === null) {
            return null;
        }
        const data = parsePaneTarget(raw["data"] ?? raw["target"], ctx.seenSessionIds);
        if (data === null) {
            return null;
        }
        return {
            kind: "leaf",
            id: uniquePaneId(parsedId, ctx.seenPaneIds),
            data,
        };
    }
    if (raw["kind"] === "split") {
        const parsedId = parseSplitId(raw["id"]);
        const axis = raw["axis"];
        const ratio = raw["ratio"];
        if (parsedId === null || (axis !== "row" && axis !== "column") || typeof ratio !== "number") {
            return null;
        }
        const first = parseSplitNode(raw["first"], ctx);
        if (first === null) {
            return null;
        }
        const second = parseSplitNode(raw["second"], ctx);
        if (second === null) {
            return null;
        }
        return {
            kind: "split",
            id: uniqueSplitId(parsedId, ctx.seenSplitIds),
            axis,
            ratio: clampSplitRatio(ratio),
            first,
            second,
        };
    }
    return null;
}

/** Validate and normalize an untrusted persisted payload into a {@link WorkspaceSplitLayout}. */
export function parseWorkspaceSplitLayout(raw: unknown): WorkspaceSplitLayout | null {
    if (!isRecord(raw)) {
        return null;
    }
    const ctx: ParseContext = {
        seenPaneIds: new Set<PaneId>(),
        seenSplitIds: new Set<SplitId>(),
        seenSessionIds: new Set<SessionId>(),
        leafCount: 0,
    };
    const root = parseSplitNode(raw["root"], ctx);
    if (root === null) {
        return null;
    }
    const parsedFocused = parsePaneId(raw["focusedPaneId"]);
    const focusedPaneId =
        parsedFocused !== null && findLeafPane(root, parsedFocused) !== null ? parsedFocused : firstTreeLeaf(root).id;
    return {
        root,
        focusedPaneId,
    };
}

/** Serialize a {@link WorkspaceSplitLayout} for localStorage persistence. */
export function serializeWorkspaceSplitLayout(layout: WorkspaceSplitLayout): string {
    return JSON.stringify(layout);
}

/** Load and validate a persisted {@link WorkspaceSplitLayout} from storage, returning `null` on absence or corruption. */
export function loadWorkspaceSplitLayout(storage?: Pick<Storage, "getItem">): WorkspaceSplitLayout | null {
    try {
        const target = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
        if (target === undefined) {
            return null;
        }
        const raw = target.getItem(WORKSPACE_SPLIT_STORAGE_KEY);
        if (raw === null) {
            return null;
        }
        return parseWorkspaceSplitLayout(JSON.parse(raw) as unknown);
    } catch {
        return null;
    }
}

/** Persist a {@link WorkspaceSplitLayout} to storage, ignoring storage access failures. */
export function saveWorkspaceSplitLayout(layout: WorkspaceSplitLayout, storage?: Pick<Storage, "setItem">): void {
    try {
        const target = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
        if (target === undefined) {
            return;
        }
        target.setItem(WORKSPACE_SPLIT_STORAGE_KEY, serializeWorkspaceSplitLayout(layout));
    } catch {
        // Ignore storage quota or security restrictions so workspace interactions keep running.
    }
}
