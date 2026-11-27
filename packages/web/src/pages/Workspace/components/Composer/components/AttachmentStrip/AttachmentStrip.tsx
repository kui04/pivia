import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { IconButton, Image, ImageViewer, ScrollArea, Tabular } from "@components";
import { cn, Formatter } from "@/lib";

import type { AttachmentId, StagedImageAttachment } from "../../types";
import styles from "./AttachmentStrip.module.css";

export interface AttachmentStripProps {
    /** Staged image attachments rendered in horizontal order. */
    readonly items: readonly StagedImageAttachment[];
    /** Invoked when the user removes a staged image tile. */
    readonly onRemove: (id: AttachmentId) => void;
    /** Optional class name merged onto the outer strip container. */
    readonly className?: string | undefined;
}

const SCROLL_STEP_PX = 200;
const WHEEL_LINE_PX = 16;

/**
 * Horizontal scrolling strip of compact staged image thumbnails with wheel-to-horizontal
 * translation, hidden scrollbars, and modal inspection via `ImageViewer`.
 */
export function AttachmentStrip({ items, onRemove, className }: AttachmentStripProps): ReactElement | null {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const [edges, setEdges] = useState({ left: false, right: false });
    const [viewer, setViewer] = useState<{ readonly open: boolean; readonly id: AttachmentId } | null>(null);

    const measureEdges = useCallback(() => {
        const element = viewportRef.current;
        if (element === null) {
            return;
        }
        const overflow = element.scrollWidth - element.clientWidth;
        setEdges({
            left: element.scrollLeft > 1,
            right: overflow > 1 && element.scrollLeft < overflow - 1,
        });
    }, []);

    useEffect(() => {
        measureEdges();
        const element = viewportRef.current;
        if (element === null) {
            return;
        }
        const handleWheel = (event: WheelEvent): void => {
            if (element.scrollWidth <= element.clientWidth) {
                return;
            }
            // Let horizontal trackpad/Shift+Wheel gestures use the browser's native horizontal scroll.
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
                return;
            }
            const delta =
                event.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? event.deltaY * WHEEL_LINE_PX
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                      ? event.deltaY * element.clientWidth
                      : event.deltaY;
            if (delta === 0) {
                return;
            }
            event.preventDefault();
            element.scrollLeft += delta;
        };

        element.addEventListener("scroll", measureEdges, { passive: true });
        // Register non-passive wheel listener so vertical wheel events translate smoothly sideways without page scroll.
        element.addEventListener("wheel", handleWheel, { passive: false });

        if (typeof ResizeObserver === "undefined") {
            return () => {
                element.removeEventListener("scroll", measureEdges);
                element.removeEventListener("wheel", handleWheel);
            };
        }
        const observer = new ResizeObserver(measureEdges);
        observer.observe(element);
        return () => {
            element.removeEventListener("scroll", measureEdges);
            element.removeEventListener("wheel", handleWheel);
            observer.disconnect();
        };
    }, [items.length, measureEdges]);

    const selectedItem = viewer !== null ? items.find((item) => item.id === viewer.id) : undefined;

    if (items.length === 0) {
        return null;
    }

    const nudge = (direction: -1 | 1): void => {
        const reducedMotion =
            typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        viewportRef.current?.scrollBy({
            left: direction * SCROLL_STEP_PX,
            behavior: reducedMotion ? "auto" : "smooth",
        });
    };

    return (
        <>
            <div className={cn(styles.strip, className)}>
                <ScrollArea
                    label="Staged attachments"
                    className={styles.scroll}
                    viewportRef={viewportRef}
                    viewportTabIndex={-1}
                >
                    <ul className={styles.list} aria-label="Attachments">
                        {items.map((item) => {
                            const sizeLabel = Formatter.byteSize(item.byteLength);
                            return (
                                <li key={item.id} className={styles.card}>
                                    <Image
                                        src={`data:${item.image.mimeType};base64,${item.image.data}`}
                                        alt={item.name}
                                        openLabel={`Inspect ${item.name}`}
                                        title={`${item.name} · ${sizeLabel}`}
                                        className={styles.imageTrigger}
                                        imgClassName={styles.thumb}
                                        onOpen={() => {
                                            setViewer({ open: true, id: item.id });
                                        }}
                                    />
                                    <div className={styles.meta}>
                                        <span className={styles.name} title={item.name}>
                                            {item.name}
                                        </span>
                                        <Tabular className={styles.subtitle}>{sizeLabel}</Tabular>
                                    </div>
                                    <IconButton
                                        type="button"
                                        label={`Remove ${item.name}`}
                                        size="sm"
                                        radius="full"
                                        className={styles.removeButton}
                                        onClick={() => {
                                            onRemove(item.id);
                                        }}
                                    >
                                        <X />
                                    </IconButton>
                                </li>
                            );
                        })}
                    </ul>
                </ScrollArea>
                {edges.left ? (
                    <div className={styles.edge} data-side="left">
                        <IconButton
                            type="button"
                            label="Scroll attachments left"
                            size="sm"
                            radius="full"
                            className={styles.nudgeButton}
                            onClick={() => {
                                nudge(-1);
                            }}
                        >
                            <ChevronLeft />
                        </IconButton>
                    </div>
                ) : null}
                {edges.right ? (
                    <div className={styles.edge} data-side="right">
                        <IconButton
                            type="button"
                            label="Scroll attachments right"
                            size="sm"
                            radius="full"
                            className={styles.nudgeButton}
                            onClick={() => {
                                nudge(1);
                            }}
                        >
                            <ChevronRight />
                        </IconButton>
                    </div>
                ) : null}
            </div>

            {viewer !== null && selectedItem !== undefined ? (
                <ImageViewer
                    open={viewer.open}
                    onOpenChange={(open) => {
                        if (!open) {
                            setViewer((prev) => (prev === null ? null : { open: false, id: prev.id }));
                        }
                    }}
                    src={`data:${selectedItem.image.mimeType};base64,${selectedItem.image.data}`}
                    alt={selectedItem.name}
                    caption={`${selectedItem.name} · ${Formatter.byteSize(selectedItem.byteLength)}`}
                />
            ) : null}
        </>
    );
}
