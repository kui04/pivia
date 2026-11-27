import type { DropTargetRect } from "@/hooks";

/** Directional drop zones for dockable split-pane surfaces. */
export type DropDockZone = "center" | "left" | "right" | "top" | "bottom";

/** Options for {@link computeDropDockZone}. */
export interface DockZoneOptions {
    /**
     * Normalized inset from each edge `[0.05, 0.45]` that maps to `"left" | "right" | "top" | "bottom"`.
     * Defaults to `0.28`.
     */
    readonly edgeThreshold?: number | undefined;
    /** Subset of zones permitted on this drop target; defaults to all five zones. */
    readonly allowedZones?: readonly DropDockZone[] | undefined;
}

/** Minimal `DataTransfer` surface needed to read/write typed drag payloads. */
export type ReadableDataTransfer = Pick<DataTransfer, "types" | "getData">;
export type WritableDataTransfer = Pick<DataTransfer, "setData">;
export type DragImageDataTransfer = Pick<DataTransfer, "setDragImage">;
export type StartDragDataTransfer = WritableDataTransfer &
    Partial<DragImageDataTransfer> & {
        effectAllowed: DataTransfer["effectAllowed"];
    };

/** All five dock zones supported by {@link computeDropDockZone}. */
export const ALL_DOCK_ZONES: readonly DropDockZone[] = ["left", "right", "top", "bottom", "center"];

/** Default normalized edge band used by {@link computeDropDockZone}. */
export const DEFAULT_DOCK_EDGE_THRESHOLD = 0.28;

const MIN_EDGE_THRESHOLD = 0.05;
const MAX_EDGE_THRESHOLD = 0.45;
type EdgeZone = Exclude<DropDockZone, "center">;

function resolveEdgeThreshold(raw: number | undefined): number {
    if (raw === undefined || !Number.isFinite(raw)) {
        return DEFAULT_DOCK_EDGE_THRESHOLD;
    }
    return Math.min(MAX_EDGE_THRESHOLD, Math.max(MIN_EDGE_THRESHOLD, raw));
}

/**
 * Resolve which dock zone (`left`, `right`, `top`, `bottom`, or `center`) a pointer position
 * targets within `rect`, returning `null` if `rect` is empty, the pointer is outside `rect`, or
 * `allowedZones` is empty.
 */
export function computeDropDockZone(
    rect: DropTargetRect,
    clientX: number,
    clientY: number,
    options?: DockZoneOptions,
): DropDockZone | null {
    if (
        !Number.isFinite(rect.left) ||
        !Number.isFinite(rect.top) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height) ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY) ||
        rect.width <= 0 ||
        rect.height <= 0
    ) {
        return null;
    }

    if (
        clientX < rect.left ||
        clientX > rect.left + rect.width ||
        clientY < rect.top ||
        clientY > rect.top + rect.height
    ) {
        return null;
    }

    const allowed = new Set<DropDockZone>(options?.allowedZones ?? ALL_DOCK_ZONES);
    if (allowed.size === 0) {
        return null;
    }

    const threshold = resolveEdgeThreshold(options?.edgeThreshold);
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;

    const edgeDistances: ReadonlyArray<readonly [EdgeZone, number]> = [
        ["left", nx],
        ["right", 1 - nx],
        ["top", ny],
        ["bottom", 1 - ny],
    ];

    let bestBandZone: EdgeZone | null = null;
    let bestBandDist = Number.POSITIVE_INFINITY;
    let nearestAllowedEdge: EdgeZone | null = null;
    let nearestAllowedDist = Number.POSITIVE_INFINITY;

    for (const [zone, dist] of edgeDistances) {
        if (!allowed.has(zone)) {
            continue;
        }
        if (dist < nearestAllowedDist) {
            nearestAllowedDist = dist;
            nearestAllowedEdge = zone;
        }
        if (dist < threshold && dist < bestBandDist) {
            bestBandDist = dist;
            bestBandZone = zone;
        }
    }

    if (bestBandZone !== null) {
        return bestBandZone;
    }
    if (allowed.has("center")) {
        return "center";
    }
    return nearestAllowedEdge;
}

/** True when `dataTransfer.types` contains `mimeType` (safe to call during `dragenter`/`dragover`). */
export function hasDragType(dataTransfer: Pick<DataTransfer, "types"> | null | undefined, mimeType: string): boolean {
    if (dataTransfer == null) {
        return false;
    }
    for (const type of dataTransfer.types) {
        if (type === mimeType) {
            return true;
        }
    }
    return false;
}

/** Store a string payload on `dataTransfer` under `mimeType`. */
export function setDragData(dataTransfer: WritableDataTransfer, mimeType: string, value: string): void {
    try {
        dataTransfer.setData(mimeType, value);
    } catch {
        // Ignore browser DataTransfer restrictions in synthetic or read-only drag events.
    }
}

/** Read a string payload for `mimeType` during `drop`, returning `null` if absent or empty. */
export function getDragData(dataTransfer: ReadableDataTransfer | null | undefined, mimeType: string): string | null {
    if (dataTransfer == null) {
        return null;
    }
    try {
        const raw = dataTransfer.getData(mimeType);
        return raw === "" ? null : raw;
    } catch {
        return null;
    }
}

/**
 * Attach a compact pill drag preview onto `dataTransfer` instead of letting the browser snapshot
 * an entire wide sidebar button or topbar header, then removes the temporary DOM node on the next frame.
 */
export function setCustomDragPreview(
    dataTransfer: Partial<DragImageDataTransfer> | null | undefined,
    label: string,
): void {
    if (dataTransfer == null || typeof dataTransfer.setDragImage !== "function" || typeof document === "undefined") {
        return;
    }
    const text = label.trim() === "" ? "Item" : label.trim();
    const preview = document.createElement("div");
    preview.textContent = text;
    preview.setAttribute("aria-hidden", "true");
    preview.style.position = "fixed";
    preview.style.insetBlockStart = "-1000px";
    preview.style.insetInlineStart = "-1000px";
    preview.style.maxInlineSize = "calc(var(--content-max-width, 960px) / 4)";
    preview.style.padding = "var(--space-6, 6px) var(--space-12, 12px)";
    preview.style.borderRadius = "var(--shape-corner-small, 8px)";
    preview.style.border = "var(--border-width, 1px) solid var(--color-primary, #0078d4)";
    preview.style.backgroundColor = "var(--color-surface-container-highest, #313131)";
    preview.style.color = "var(--color-on-surface, #cccccc)";
    preview.style.fontFamily = "var(--font-sans, sans-serif)";
    preview.style.fontSize = "var(--type-code-size, 0.8125rem)";
    preview.style.fontWeight = "var(--font-weight-medium, 500)";
    preview.style.lineHeight = "var(--type-code-line-height, 1.25rem)";
    preview.style.whiteSpace = "nowrap";
    preview.style.overflow = "hidden";
    preview.style.textOverflow = "ellipsis";
    preview.style.boxShadow = "var(--elevation-2, 0 2px 6px rgb(0 0 0 / 0.2))";
    preview.style.pointerEvents = "none";

    document.body.appendChild(preview);
    try {
        dataTransfer.setDragImage(preview, 14, 14);
    } catch {
        preview.remove();
        return;
    }
    const cleanup = (): void => {
        preview.remove();
    };
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(cleanup);
    } else {
        setTimeout(cleanup, 0);
    }
}

/** Populate typed MIME data, plain-text fallback, `effectAllowed`, and custom drag preview together. */
export function startDragPayload(
    dataTransfer: StartDragDataTransfer,
    mimeType: string,
    payload: string,
    previewLabel: string,
    effectAllowed: DataTransfer["effectAllowed"] = "move",
): void {
    setDragData(dataTransfer, mimeType, payload);
    setDragData(dataTransfer, "text/plain", previewLabel);
    setCustomDragPreview(dataTransfer, previewLabel);
    dataTransfer.effectAllowed = effectAllowed;
}
