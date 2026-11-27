import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { useDropTarget, type DropTargetRect, type DropZoneState } from "@/hooks";
import { cn } from "@/lib";

import { ALL_DOCK_ZONES, computeDropDockZone, type DropDockZone } from "./dnd";
import styles from "./SplitPane.module.css";
import {
    canSplitWithinMinSize,
    clampRatioForContainer,
    computeSplitRatioBounds,
    computeTreeGeometry,
    DEFAULT_MIN_PANE_HEIGHT_PX,
    DEFAULT_MIN_PANE_WIDTH_PX,
    DEFAULT_SPLIT_RATIO,
    type PaneId,
    type PaneSizePx,
    type SplitId,
    type SplitTreeBranch,
    type SplitTreeLeaf,
    type SplitTreeNode,
} from "./tree";

const KEYBOARD_RESIZE_STEP = 0.05;

function defaultZoneLabel(zone: DropDockZone): string {
    switch (zone) {
        case "left":
            return "Dock left";
        case "right":
            return "Dock right";
        case "top":
            return "Dock top";
        case "bottom":
            return "Dock bottom";
        case "center":
            return "Drop here";
    }
}

/** Metadata passed to {@link SplitPaneProps.renderLeaf} for each terminal pane. */
export interface SplitPaneLeafMeta {
    readonly isFocused: boolean;
    readonly sizePx: PaneSizePx | undefined;
    readonly canSplitRow: boolean;
    readonly canSplitColumn: boolean;
}

/** Drag-and-drop docking configuration for {@link SplitPane} leaves. */
export interface SplitPaneDropConfig<TData> {
    /** Return `true` when the active drag payload (inspectable via `dataTransfer.types`) can drop onto `targetLeaf`. */
    readonly canDrop: (dataTransfer: DataTransfer, targetLeaf: SplitTreeLeaf<TData>) => boolean;
    /** Optional subset of dock zones allowed for `targetLeaf`; defaults to all five zones. */
    readonly allowedZones?:
        ((dataTransfer: DataTransfer, targetLeaf: SplitTreeLeaf<TData>) => readonly DropDockZone[]) | undefined;
    /** Normalized inset `[0.05, 0.45]` from each edge; defaults to `0.28`. */
    readonly edgeThreshold?: number | undefined;
    /** Optional label shown inside the drop preview overlay for `zone`. */
    readonly zoneLabel?: ((zone: DropDockZone, targetLeaf: SplitTreeLeaf<TData>) => string) | undefined;
    /** Called when an accepted drag drops onto `targetLeaf` at `zone`. */
    readonly onDrop: (dataTransfer: DataTransfer, targetLeaf: SplitTreeLeaf<TData>, zone: DropDockZone) => void;
}

/** Props for {@link SplitPane}. */
export interface SplitPaneProps<TData> {
    /** Binary split tree to render. */
    readonly node: SplitTreeNode<TData>;
    /** Minimum horizontal child size (px) enforced during resizing and splitting. Defaults to `320`. */
    readonly minPaneWidthPx?: number | undefined;
    /** Minimum vertical child size (px) enforced during resizing and splitting. Defaults to `240`. */
    readonly minPaneHeightPx?: number | undefined;
    /** Optional active/focused leaf id passed through to `renderLeaf`. */
    readonly focusedPaneId?: PaneId | undefined;
    /** Optional drag-and-drop docking preview and drop handler per leaf. */
    readonly dropConfig?: SplitPaneDropConfig<TData> | undefined;
    /** Optional callback notified whenever measured leaf pixel dimensions update. */
    readonly onLeafSizesChange?: ((sizes: ReadonlyMap<PaneId, PaneSizePx>) => void) | undefined;
    /** Optional outer class name merged onto the root container. */
    readonly className?: string | undefined;
    /** Render callback for each terminal leaf node. */
    readonly renderLeaf: (leaf: SplitTreeLeaf<TData>, meta: SplitPaneLeafMeta) => ReactElement;
    /** Called when a split divider commits a new ratio via pointer drag, double-click, or keyboard navigation. */
    readonly onResizeSplit: (splitId: SplitId, ratio: number) => void;
}

interface ActiveDropState {
    readonly paneId: PaneId;
    readonly zone: DropDockZone;
}

interface SplitLeafSlotProps<TData> {
    readonly leaf: SplitTreeLeaf<TData>;
    readonly isFocused: boolean;
    readonly sizePx: PaneSizePx | undefined;
    readonly canSplitRow: boolean;
    readonly canSplitColumn: boolean;
    readonly activeDropZone: DropDockZone | null;
    readonly dropConfig?: SplitPaneDropConfig<TData> | undefined;
    readonly onDropHover: (paneId: PaneId, state: DropZoneState<DropDockZone>) => void;
    readonly renderLeaf: (leaf: SplitTreeLeaf<TData>, meta: SplitPaneLeafMeta) => ReactElement;
}

function SplitLeafSlotInner<TData>({
    leaf,
    isFocused,
    sizePx,
    canSplitRow,
    canSplitColumn,
    activeDropZone,
    dropConfig,
    onDropHover,
    renderLeaf,
}: SplitLeafSlotProps<TData>): ReactElement {
    const canDrop = useCallback(
        (dataTransfer: DataTransfer) => dropConfig?.canDrop(dataTransfer, leaf) ?? false,
        [dropConfig, leaf],
    );

    const resolveZone = useCallback(
        (rect: DropTargetRect, clientX: number, clientY: number, dataTransfer: DataTransfer): DropDockZone | null => {
            if (dropConfig === undefined) {
                return null;
            }
            const baseAllowed = dropConfig.allowedZones?.(dataTransfer, leaf) ?? ALL_DOCK_ZONES;
            const filtered = baseAllowed.filter((zone) => {
                if ((zone === "left" || zone === "right") && !canSplitRow) {
                    return false;
                }
                if ((zone === "top" || zone === "bottom") && !canSplitColumn) {
                    return false;
                }
                return true;
            });
            return computeDropDockZone(rect, clientX, clientY, {
                edgeThreshold: dropConfig.edgeThreshold,
                allowedZones: filtered,
            });
        },
        [canSplitColumn, canSplitRow, dropConfig, leaf],
    );

    const handleStateChange = useCallback(
        (nextState: DropZoneState<DropDockZone>) => {
            onDropHover(leaf.id, nextState);
        },
        [leaf.id, onDropHover],
    );

    const handleDrop = useCallback(
        (dataTransfer: DataTransfer, zone: DropDockZone) => {
            onDropHover(leaf.id, { active: false });
            dropConfig?.onDrop(dataTransfer, leaf, zone);
        },
        [dropConfig, leaf, onDropHover],
    );

    const { dropProps } = useDropTarget<DropDockZone>({
        disabled: dropConfig === undefined,
        canDrop,
        resolveZone,
        onStateChange: handleStateChange,
        onDrop: handleDrop,
    });

    const hintLabel =
        activeDropZone !== null
            ? (dropConfig?.zoneLabel?.(activeDropZone, leaf) ?? defaultZoneLabel(activeDropZone))
            : null;

    return (
        <div
            className={styles.leaf}
            data-focused={isFocused || undefined}
            {...(dropConfig === undefined ? {} : dropProps)}
        >
            {renderLeaf(leaf, { isFocused, sizePx, canSplitRow, canSplitColumn })}
            {activeDropZone !== null && hintLabel !== null ? (
                <div className={styles.dropOverlay} data-zone={activeDropZone} aria-hidden="true">
                    <span className={styles.dropHint}>{hintLabel}</span>
                </div>
            ) : null}
        </div>
    );
}

const SplitLeafSlot = memo(SplitLeafSlotInner) as typeof SplitLeafSlotInner;

interface SplitBranchSlotProps<TData> {
    readonly node: SplitTreeBranch<TData>;
    readonly minPaneWidthPx: number;
    readonly minPaneHeightPx: number;
    readonly focusedPaneId?: PaneId | undefined;
    readonly leafSizes: ReadonlyMap<PaneId, PaneSizePx>;
    readonly splitSizes: ReadonlyMap<SplitId, PaneSizePx>;
    readonly activeDrop: ActiveDropState | null;
    readonly dropConfig?: SplitPaneDropConfig<TData> | undefined;
    readonly onDropHover: (paneId: PaneId, state: DropZoneState<DropDockZone>) => void;
    readonly renderLeaf: (leaf: SplitTreeLeaf<TData>, meta: SplitPaneLeafMeta) => ReactElement;
    readonly onResizeSplit: (splitId: SplitId, ratio: number) => void;
}

function SplitBranchSlotInner<TData>({
    node,
    minPaneWidthPx,
    minPaneHeightPx,
    focusedPaneId,
    leafSizes,
    splitSizes,
    activeDrop,
    dropConfig,
    onDropHover,
    renderLeaf,
    onResizeSplit,
}: SplitBranchSlotProps<TData>): ReactElement {
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRatioRef = useRef<number | null>(null);
    const [dragging, setDragging] = useState(false);
    const [dragRatio, setDragRatio] = useState<number | null>(null);

    const minPx = node.axis === "row" ? minPaneWidthPx : minPaneHeightPx;
    const splitSize = splitSizes.get(node.id);
    const containerAxisPx = node.axis === "row" ? (splitSize?.width ?? 0) : (splitSize?.height ?? 0);
    const ratioBounds = computeSplitRatioBounds(containerAxisPx, minPx);
    const displayRatio = dragRatio ?? node.ratio;

    const previewRatioFromClientPos = useCallback(
        (clientX: number, clientY: number) => {
            const container = containerRef.current;
            if (container === null) {
                return;
            }
            const rect = container.getBoundingClientRect();
            const size = node.axis === "row" ? rect.width : rect.height;
            if (size <= 0) {
                return;
            }
            const offset = node.axis === "row" ? clientX - rect.left : clientY - rect.top;
            const ratio = clampRatioForContainer(offset / size, size, minPx);
            dragRatioRef.current = ratio;
            setDragRatio(ratio);
        },
        [minPx, node.axis],
    );

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        previewRatioFromClientPos(event.clientX, event.clientY);
    };

    const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!dragging) {
            return;
        }
        previewRatioFromClientPos(event.clientX, event.clientY);
    };

    const stopDragging = (event: React.PointerEvent<HTMLDivElement>): void => {
        if (!dragging) {
            return;
        }
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setDragging(false);
        const committed = dragRatioRef.current;
        dragRatioRef.current = null;
        setDragRatio(null);
        if (committed !== null) {
            onResizeSplit(node.id, committed);
        }
    };

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        const liveSizePx =
            containerAxisPx > 0
                ? containerAxisPx
                : (() => {
                      const rect = containerRef.current?.getBoundingClientRect();
                      if (rect === undefined) {
                          return 0;
                      }
                      return node.axis === "row" ? rect.width : rect.height;
                  })();
        const liveBounds = computeSplitRatioBounds(liveSizePx, minPx);

        if (node.axis === "row") {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                onResizeSplit(node.id, clampRatioForContainer(node.ratio - KEYBOARD_RESIZE_STEP, liveSizePx, minPx));
                return;
            }
            if (event.key === "ArrowRight") {
                event.preventDefault();
                onResizeSplit(node.id, clampRatioForContainer(node.ratio + KEYBOARD_RESIZE_STEP, liveSizePx, minPx));
                return;
            }
        } else {
            if (event.key === "ArrowUp") {
                event.preventDefault();
                onResizeSplit(node.id, clampRatioForContainer(node.ratio - KEYBOARD_RESIZE_STEP, liveSizePx, minPx));
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                onResizeSplit(node.id, clampRatioForContainer(node.ratio + KEYBOARD_RESIZE_STEP, liveSizePx, minPx));
                return;
            }
        }
        if (event.key === "Home") {
            event.preventDefault();
            onResizeSplit(node.id, liveBounds.min);
            return;
        }
        if (event.key === "End") {
            event.preventDefault();
            onResizeSplit(node.id, liveBounds.max);
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            onResizeSplit(node.id, clampRatioForContainer(DEFAULT_SPLIT_RATIO, liveSizePx, minPx));
        }
    };

    return (
        <div ref={containerRef} className={styles.split} data-axis={node.axis}>
            <div className={styles.branch} style={{ flex: `${String(displayRatio)} 1 0` }}>
                <SplitNodeSlot
                    node={node.first}
                    minPaneWidthPx={minPaneWidthPx}
                    minPaneHeightPx={minPaneHeightPx}
                    focusedPaneId={focusedPaneId}
                    leafSizes={leafSizes}
                    splitSizes={splitSizes}
                    activeDrop={activeDrop}
                    dropConfig={dropConfig}
                    onDropHover={onDropHover}
                    renderLeaf={renderLeaf}
                    onResizeSplit={onResizeSplit}
                />
            </div>
            <div
                role="slider"
                tabIndex={0}
                aria-orientation={node.axis === "row" ? "vertical" : "horizontal"}
                aria-label={node.axis === "row" ? "Resize horizontal split" : "Resize vertical split"}
                aria-valuemin={Math.round(ratioBounds.min * 100)}
                aria-valuemax={Math.round(ratioBounds.max * 100)}
                aria-valuenow={Math.round(displayRatio * 100)}
                data-dragging={dragging}
                className={styles.divider}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={stopDragging}
                onPointerCancel={stopDragging}
                onDoubleClick={() => {
                    onResizeSplit(node.id, clampRatioForContainer(DEFAULT_SPLIT_RATIO, containerAxisPx, minPx));
                }}
                onKeyDown={handleKeyDown}
            >
                <span className={styles.dividerLine} aria-hidden="true" />
            </div>
            <div className={styles.branch} style={{ flex: `${String(1 - displayRatio)} 1 0` }}>
                <SplitNodeSlot
                    node={node.second}
                    minPaneWidthPx={minPaneWidthPx}
                    minPaneHeightPx={minPaneHeightPx}
                    focusedPaneId={focusedPaneId}
                    leafSizes={leafSizes}
                    splitSizes={splitSizes}
                    activeDrop={activeDrop}
                    dropConfig={dropConfig}
                    onDropHover={onDropHover}
                    renderLeaf={renderLeaf}
                    onResizeSplit={onResizeSplit}
                />
            </div>
        </div>
    );
}

const SplitBranchSlot = memo(SplitBranchSlotInner) as typeof SplitBranchSlotInner;

interface SplitNodeSlotProps<TData> {
    readonly node: SplitTreeNode<TData>;
    readonly minPaneWidthPx: number;
    readonly minPaneHeightPx: number;
    readonly focusedPaneId?: PaneId | undefined;
    readonly leafSizes: ReadonlyMap<PaneId, PaneSizePx>;
    readonly splitSizes: ReadonlyMap<SplitId, PaneSizePx>;
    readonly activeDrop: ActiveDropState | null;
    readonly dropConfig?: SplitPaneDropConfig<TData> | undefined;
    readonly onDropHover: (paneId: PaneId, state: DropZoneState<DropDockZone>) => void;
    readonly renderLeaf: (leaf: SplitTreeLeaf<TData>, meta: SplitPaneLeafMeta) => ReactElement;
    readonly onResizeSplit: (splitId: SplitId, ratio: number) => void;
}

function SplitNodeSlotInner<TData>({
    node,
    minPaneWidthPx,
    minPaneHeightPx,
    focusedPaneId,
    leafSizes,
    splitSizes,
    activeDrop,
    dropConfig,
    onDropHover,
    renderLeaf,
    onResizeSplit,
}: SplitNodeSlotProps<TData>): ReactElement {
    if (node.kind === "leaf") {
        const sizePx = leafSizes.get(node.id);
        return (
            <SplitLeafSlot
                leaf={node}
                isFocused={focusedPaneId === node.id}
                sizePx={sizePx}
                canSplitRow={canSplitWithinMinSize(sizePx, "row", minPaneWidthPx, minPaneHeightPx)}
                canSplitColumn={canSplitWithinMinSize(sizePx, "column", minPaneWidthPx, minPaneHeightPx)}
                activeDropZone={activeDrop?.paneId === node.id ? activeDrop.zone : null}
                dropConfig={dropConfig}
                onDropHover={onDropHover}
                renderLeaf={renderLeaf}
            />
        );
    }
    return (
        <SplitBranchSlot
            node={node}
            minPaneWidthPx={minPaneWidthPx}
            minPaneHeightPx={minPaneHeightPx}
            focusedPaneId={focusedPaneId}
            leafSizes={leafSizes}
            splitSizes={splitSizes}
            activeDrop={activeDrop}
            dropConfig={dropConfig}
            onDropHover={onDropHover}
            renderLeaf={renderLeaf}
            onResizeSplit={onResizeSplit}
        />
    );
}

const SplitNodeSlot = memo(SplitNodeSlotInner) as typeof SplitNodeSlotInner;

/**
 * Generic recursive resizable split-pane layout with accessible divider sliders, configurable
 * minimum pane dimensions, and single-active directional drag-and-drop docking overlays.
 */
export function SplitPane<TData>({
    node,
    minPaneWidthPx = DEFAULT_MIN_PANE_WIDTH_PX,
    minPaneHeightPx = DEFAULT_MIN_PANE_HEIGHT_PX,
    focusedPaneId,
    dropConfig,
    onLeafSizesChange,
    className,
    renderLeaf,
    onResizeSplit,
}: SplitPaneProps<TData>): ReactElement {
    const rootRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState<{ readonly width: number; readonly height: number }>({
        width: 0,
        height: 0,
    });
    const [activeDrop, setActiveDrop] = useState<ActiveDropState | null>(null);

    useEffect(() => {
        const element = rootRef.current;
        if (element === null) {
            return undefined;
        }
        const update = (width: number, height: number): void => {
            setContainerSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
        };
        const rect = element.getBoundingClientRect();
        update(rect.width, rect.height);
        if (typeof ResizeObserver === "undefined") {
            return undefined;
        }
        const observer = new ResizeObserver((entries) => {
            const first = entries[0];
            if (first !== undefined) {
                update(first.contentRect.width, first.contentRect.height);
            }
        });
        observer.observe(element);
        return () => {
            observer.disconnect();
        };
    }, []);

    const geometry = useMemo(
        () => computeTreeGeometry(node, containerSize.width, containerSize.height),
        [containerSize.height, containerSize.width, node],
    );

    useEffect(() => {
        onLeafSizesChange?.(geometry.leafSizes);
    }, [geometry.leafSizes, onLeafSizesChange]);

    // Ensure at most one leaf across the entire SplitPane displays a drop preview at once.
    // Cleanup on dragend/drop is delegated to useDropTarget's global window listeners via onStateChange.
    const handleDropHover = useCallback((paneId: PaneId, nextState: DropZoneState<DropDockZone>) => {
        setActiveDrop((prev) => {
            if (nextState.active) {
                if (prev !== null && prev.paneId === paneId && prev.zone === nextState.zone) {
                    return prev;
                }
                return { paneId, zone: nextState.zone };
            }
            if (prev === null || prev.paneId !== paneId) {
                return prev;
            }
            return null;
        });
    }, []);

    return (
        <div ref={rootRef} className={cn(styles.root, className)}>
            <SplitNodeSlot
                node={node}
                minPaneWidthPx={minPaneWidthPx}
                minPaneHeightPx={minPaneHeightPx}
                focusedPaneId={focusedPaneId}
                leafSizes={geometry.leafSizes}
                splitSizes={geometry.splitSizes}
                activeDrop={activeDrop}
                dropConfig={dropConfig}
                onDropHover={handleDropHover}
                renderLeaf={renderLeaf}
                onResizeSplit={onResizeSplit}
            />
        </div>
    );
}
