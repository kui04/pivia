declare const PANE_ID_BRAND: unique symbol;
declare const SPLIT_ID_BRAND: unique symbol;
declare const SPLIT_RATIO_BRAND: unique symbol;

/** Branded identifier of one leaf pane inside a split tree. */
export type PaneId = string & { readonly [PANE_ID_BRAND]: never };

/** Branded identifier of one internal split node inside a split tree. */
export type SplitId = string & { readonly [SPLIT_ID_BRAND]: never };

/** Validated split proportion in `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]`. */
export type SplitRatio = number & { readonly [SPLIT_RATIO_BRAND]: never };

/** Axis along which a split node arranges its two children (`row` = side-by-side, `column` = stacked). */
export type SplitAxis = "row" | "column";

/** Relative placement of a newly inserted or moved sibling leaf around a target leaf. */
export type SplitPlacement = "first" | "second";

/** Measured or projected pixel dimensions of a leaf pane. */
export interface PaneSizePx {
    readonly width: number;
    readonly height: number;
}

/** Pixel dimensions computed in one pass across all leaves and split nodes. */
export interface TreeGeometry {
    readonly leafSizes: ReadonlyMap<PaneId, PaneSizePx>;
    readonly splitSizes: ReadonlyMap<SplitId, PaneSizePx>;
}

/** Validated `[min, max]` split ratio bounds after applying pixel minimum constraints. */
export interface SplitRatioBounds {
    readonly min: SplitRatio;
    readonly max: SplitRatio;
}

/** Minimum proportion allocated to the first child of a split. */
export const MIN_SPLIT_RATIO = 0.15;

/** Maximum proportion allocated to the first child of a split. */
export const MAX_SPLIT_RATIO = 0.85;

/** Default equal split proportion. */
export const DEFAULT_SPLIT_RATIO: SplitRatio = 0.5 as SplitRatio;

/** Default minimum usable pane width (px) enforced when splitting or resizing horizontally. */
export const DEFAULT_MIN_PANE_WIDTH_PX = 320;

/** Default minimum usable pane height (px) enforced when splitting or resizing vertically. */
export const DEFAULT_MIN_PANE_HEIGHT_PX = 240;

/** Terminal leaf node carrying domain-specific payload `TData`. */
export interface SplitTreeLeaf<TData> {
    readonly kind: "leaf";
    readonly id: PaneId;
    readonly data: TData;
}

/** Internal binary split node dividing space between two non-empty subtrees. */
export interface SplitTreeBranch<TData> {
    readonly kind: "split";
    readonly id: SplitId;
    readonly axis: SplitAxis;
    readonly ratio: SplitRatio;
    readonly first: SplitTreeNode<TData>;
    readonly second: SplitTreeNode<TData>;
}

/** Recursive binary split tree; always contains at least one {@link SplitTreeLeaf}. */
export type SplitTreeNode<TData> = SplitTreeLeaf<TData> | SplitTreeBranch<TData>;

const SAFE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
export const MAX_ID_LENGTH = 256;

let fallbackIdCounter = 0;

function generateSafeId(prefix: string): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
        return `${prefix}-${cryptoApi.randomUUID()}`;
    }
    fallbackIdCounter += 1;
    return `${prefix}-${String(fallbackIdCounter)}`;
}

/** Parse an untrusted value into a safe {@link PaneId}, or `null` if invalid. */
export function parsePaneId(raw: unknown): PaneId | null {
    return typeof raw === "string" && raw.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(raw) ? (raw as PaneId) : null;
}

/** Generate a fresh {@link PaneId}. */
export function createPaneId(): PaneId {
    return generateSafeId("pane") as PaneId;
}

/** Parse an untrusted value into a safe {@link SplitId}, or `null` if invalid. */
export function parseSplitId(raw: unknown): SplitId | null {
    return typeof raw === "string" && raw.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(raw)
        ? (raw as SplitId)
        : null;
}

/** Generate a fresh {@link SplitId}. */
export function createSplitId(): SplitId {
    return generateSafeId("split") as SplitId;
}

/** Clamp a raw number into a valid {@link SplitRatio}; non-finite inputs fall back to `0.5`. */
export function clampSplitRatio(value: number): SplitRatio {
    if (!Number.isFinite(value)) {
        return DEFAULT_SPLIT_RATIO;
    }
    const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, value));
    return clamped as SplitRatio;
}

/**
 * Compute accessible `[min, max]` split ratio bounds for a split container of `containerSizePx`
 * respecting both `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]` and `minPanePx`.
 */
export function computeSplitRatioBounds(containerSizePx: number, minPanePx: number): SplitRatioBounds {
    if (!Number.isFinite(containerSizePx) || containerSizePx <= 0 || !Number.isFinite(minPanePx) || minPanePx <= 0) {
        return { min: MIN_SPLIT_RATIO as SplitRatio, max: MAX_SPLIT_RATIO as SplitRatio };
    }
    const minFromPx = Math.min(0.5, minPanePx / containerSizePx);
    return {
        min: Math.max(MIN_SPLIT_RATIO, minFromPx) as SplitRatio,
        max: Math.min(MAX_SPLIT_RATIO, 1 - minFromPx) as SplitRatio,
    };
}

/** Clamp `rawRatio` into {@link computeSplitRatioBounds} for `containerSizePx` and `minPanePx`. */
export function clampRatioForContainer(rawRatio: number, containerSizePx: number, minPanePx: number): SplitRatio {
    if (!Number.isFinite(rawRatio)) {
        return DEFAULT_SPLIT_RATIO;
    }
    const { min, max } = computeSplitRatioBounds(containerSizePx, minPanePx);
    return Math.min(max, Math.max(min, rawRatio)) as SplitRatio;
}

function collectLeaves<TData>(node: SplitTreeNode<TData>, out: SplitTreeLeaf<TData>[]): void {
    if (node.kind === "leaf") {
        out.push(node);
        return;
    }
    collectLeaves(node.first, out);
    collectLeaves(node.second, out);
}

/** Return all leaf nodes in visual depth-first order (top-left to bottom-right). */
export function listTreeLeaves<TData>(root: SplitTreeNode<TData>): readonly SplitTreeLeaf<TData>[] {
    const leaves: SplitTreeLeaf<TData>[] = [];
    collectLeaves(root, leaves);
    return leaves;
}

/** Find a leaf node by id, or `null` when absent. */
export function findTreeLeaf<TData>(root: SplitTreeNode<TData>, paneId: PaneId): SplitTreeLeaf<TData> | null {
    if (root.kind === "leaf") {
        return root.id === paneId ? root : null;
    }
    return findTreeLeaf(root.first, paneId) ?? findTreeLeaf(root.second, paneId);
}

/** Return the depth-first leftmost leaf inside `node`. */
export function firstTreeLeaf<TData>(node: SplitTreeNode<TData>): SplitTreeLeaf<TData> {
    let current = node;
    while (current.kind === "split") {
        current = current.first;
    }
    return current;
}

/** Compute pixel dimensions for all leaves and internal split nodes given root container size. */
export function computeTreeGeometry<TData>(
    root: SplitTreeNode<TData>,
    containerWidth: number,
    containerHeight: number,
): TreeGeometry {
    const leafSizes = new Map<PaneId, PaneSizePx>();
    const splitSizes = new Map<SplitId, PaneSizePx>();
    if (
        !Number.isFinite(containerWidth) ||
        !Number.isFinite(containerHeight) ||
        containerWidth <= 0 ||
        containerHeight <= 0
    ) {
        return { leafSizes, splitSizes };
    }

    const walk = (node: SplitTreeNode<TData>, width: number, height: number): void => {
        if (node.kind === "leaf") {
            leafSizes.set(node.id, { width, height });
            return;
        }
        splitSizes.set(node.id, { width, height });
        if (node.axis === "row") {
            const firstWidth = width * node.ratio;
            walk(node.first, firstWidth, height);
            walk(node.second, width - firstWidth, height);
            return;
        }
        const firstHeight = height * node.ratio;
        walk(node.first, width, firstHeight);
        walk(node.second, width, height - firstHeight);
    };

    walk(root, containerWidth, containerHeight);
    return { leafSizes, splitSizes };
}

/** Compute the pixel size of every leaf pane given the root container dimensions. */
export function computeTreeLeafSizes<TData>(
    root: SplitTreeNode<TData>,
    containerWidth: number,
    containerHeight: number,
): ReadonlyMap<PaneId, PaneSizePx> {
    return computeTreeGeometry(root, containerWidth, containerHeight).leafSizes;
}

/** True when splitting a pane of `leafSize` in half along `axis` keeps both halves at or above the minimum size. */
export function canSplitWithinMinSize(
    leafSize: PaneSizePx | undefined,
    axis: SplitAxis,
    minPaneWidthPx: number,
    minPaneHeightPx: number,
): boolean {
    if (leafSize === undefined) {
        return true;
    }
    if (axis === "row") {
        return leafSize.width >= Math.max(0, minPaneWidthPx) * 2;
    }
    return leafSize.height >= Math.max(0, minPaneHeightPx) * 2;
}

/** Replace `data` on `paneId` if present. */
export function updateTreeLeafData<TData>(
    root: SplitTreeNode<TData>,
    paneId: PaneId,
    updater: NoInfer<(data: TData) => TData>,
): SplitTreeNode<TData> {
    if (root.kind === "leaf") {
        if (root.id !== paneId) {
            return root;
        }
        const nextData = updater(root.data);
        return nextData === root.data ? root : { ...root, data: nextData };
    }
    const nextFirst = updateTreeLeafData(root.first, paneId, updater);
    if (nextFirst !== root.first) {
        return { ...root, first: nextFirst };
    }
    const nextSecond = updateTreeLeafData(root.second, paneId, updater);
    if (nextSecond !== root.second) {
        return { ...root, second: nextSecond };
    }
    return root;
}

/** Split `targetPaneId` along `axis`, placing `newLeaf` on `placement` (`second` by default). */
export function splitTreeNode<TData>(
    root: SplitTreeNode<TData>,
    targetPaneId: PaneId,
    axis: SplitAxis,
    newLeaf: SplitTreeLeaf<TData>,
    placement: SplitPlacement = "second",
): SplitTreeNode<TData> {
    if (root.kind === "leaf") {
        if (root.id !== targetPaneId) {
            return root;
        }
        return {
            kind: "split",
            id: createSplitId(),
            axis,
            ratio: DEFAULT_SPLIT_RATIO,
            first: placement === "first" ? newLeaf : root,
            second: placement === "first" ? root : newLeaf,
        };
    }
    const nextFirst = splitTreeNode(root.first, targetPaneId, axis, newLeaf, placement);
    if (nextFirst !== root.first) {
        return { ...root, first: nextFirst };
    }
    const nextSecond = splitTreeNode(root.second, targetPaneId, axis, newLeaf, placement);
    if (nextSecond !== root.second) {
        return { ...root, second: nextSecond };
    }
    return root;
}

interface RemoveLeafResult<TData> {
    readonly root: SplitTreeNode<TData> | null;
    readonly removed: boolean;
    readonly fallbackFocusId: PaneId | null;
}

function removeLeafInner<TData>(node: SplitTreeNode<TData>, paneId: PaneId): RemoveLeafResult<TData> {
    if (node.kind === "leaf") {
        return node.id === paneId
            ? { root: null, removed: true, fallbackFocusId: null }
            : { root: node, removed: false, fallbackFocusId: null };
    }
    const left = removeLeafInner(node.first, paneId);
    if (left.removed) {
        if (left.root === null) {
            return {
                root: node.second,
                removed: true,
                fallbackFocusId: firstTreeLeaf(node.second).id,
            };
        }
        return {
            root: { ...node, first: left.root },
            removed: true,
            fallbackFocusId: left.fallbackFocusId ?? firstTreeLeaf(left.root).id,
        };
    }
    const right = removeLeafInner(node.second, paneId);
    if (right.removed) {
        if (right.root === null) {
            return {
                root: node.first,
                removed: true,
                fallbackFocusId: firstTreeLeaf(node.first).id,
            };
        }
        return {
            root: { ...node, second: right.root },
            removed: true,
            fallbackFocusId: right.fallbackFocusId ?? firstTreeLeaf(right.root).id,
        };
    }
    return { root: node, removed: false, fallbackFocusId: null };
}

/** Remove `paneId` and collapse its parent split into the surviving sibling (`null` if `root` was that sole leaf). */
export function removeTreeLeaf<TData>(
    root: SplitTreeNode<TData>,
    paneId: PaneId,
): { readonly root: SplitTreeNode<TData> | null; readonly fallbackFocusId: PaneId | null } {
    const result = removeLeafInner(root, paneId);
    return {
        root: result.root,
        fallbackFocusId: result.fallbackFocusId,
    };
}

function updateTreeSplitRatio<TData>(
    node: SplitTreeNode<TData>,
    splitId: SplitId,
    transform: (current: SplitRatio) => SplitRatio,
): SplitTreeNode<TData> {
    if (node.kind === "leaf") {
        return node;
    }
    if (node.id === splitId) {
        const nextRatio = transform(node.ratio);
        return nextRatio === node.ratio ? node : { ...node, ratio: nextRatio };
    }
    const nextFirst = updateTreeSplitRatio(node.first, splitId, transform);
    if (nextFirst !== node.first) {
        return { ...node, first: nextFirst };
    }
    const nextSecond = updateTreeSplitRatio(node.second, splitId, transform);
    if (nextSecond !== node.second) {
        return { ...node, second: nextSecond };
    }
    return node;
}

/** Update the ratio of `splitId` (clamped via `clampSplitRatio`). */
export function resizeTreeSplit<TData>(
    root: SplitTreeNode<TData>,
    splitId: SplitId,
    ratio: number,
): SplitTreeNode<TData> {
    const clamped = clampSplitRatio(ratio);
    return updateTreeSplitRatio(root, splitId, () => clamped);
}

/** Move an existing leaf `sourcePaneId` beside `targetPaneId` along `axis` and `placement`. */
export function moveTreeLeaf<TData>(
    root: SplitTreeNode<TData>,
    sourcePaneId: PaneId,
    targetPaneId: PaneId,
    axis: SplitAxis,
    placement: SplitPlacement,
): SplitTreeNode<TData> {
    if (sourcePaneId === targetPaneId) {
        return root;
    }
    const sourceLeaf = findTreeLeaf(root, sourcePaneId);
    if (sourceLeaf === null || findTreeLeaf(root, targetPaneId) === null) {
        return root;
    }
    const removed = removeTreeLeaf(root, sourcePaneId);
    if (removed.root === null) {
        return root;
    }
    return splitTreeNode(removed.root, targetPaneId, axis, sourceLeaf, placement);
}

function replaceLeavesForSwap<TData>(
    node: SplitTreeNode<TData>,
    aLeaf: SplitTreeLeaf<TData>,
    bLeaf: SplitTreeLeaf<TData>,
): SplitTreeNode<TData> {
    if (node.kind === "leaf") {
        if (node.id === aLeaf.id) {
            return bLeaf;
        }
        if (node.id === bLeaf.id) {
            return aLeaf;
        }
        return node;
    }
    const nextFirst = replaceLeavesForSwap(node.first, aLeaf, bLeaf);
    const nextSecond = replaceLeavesForSwap(node.second, aLeaf, bLeaf);
    if (nextFirst === node.first && nextSecond === node.second) {
        return node;
    }
    return { ...node, first: nextFirst, second: nextSecond };
}

/** Swap the positions (IDs and payloads) of two existing leaves `aId` and `bId`. */
export function swapTreeLeaves<TData>(root: SplitTreeNode<TData>, aId: PaneId, bId: PaneId): SplitTreeNode<TData> {
    if (aId === bId) {
        return root;
    }
    const aLeaf = findTreeLeaf(root, aId);
    const bLeaf = findTreeLeaf(root, bId);
    if (aLeaf === null || bLeaf === null) {
        return root;
    }
    return replaceLeavesForSwap(root, aLeaf, bLeaf);
}
