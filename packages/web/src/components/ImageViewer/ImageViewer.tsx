import { Dialog } from "@base-ui/react/dialog";
import { ImageOff, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useRef, useState } from "react";
import { TransformComponent, TransformWrapper, useControls, useTransformComponent } from "react-zoom-pan-pinch";

import { cn } from "@/lib";

import { Icon } from "../Icon/Icon";
import { IconButton } from "../IconButton/IconButton";
import styles from "./ImageViewer.module.css";

export type ImageViewerProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    src: string;
    alt: string;
    caption?: string | undefined;
    /** Applies to the dialog popup. */
    className?: string | undefined;
};

type LoadStatus = "loading" | "loaded" | "error";

/**
 * A controlled single-image viewer. Base UI Dialog owns modal focus, scroll
 * lock, Escape and focus return; react-zoom-pan-pinch owns wheel, pinch, drag
 * and double-click zoom. The caller supplies the trigger and the open state.
 *
 * Zoom actions are immediate. The dialog is the only timed transition, so the
 * viewer does not carry a second motion scale with its own durations.
 */
export function ImageViewer({ open, onOpenChange, src, alt, caption, className }: ImageViewerProps) {
    const popupRef = useRef<HTMLDivElement>(null);
    const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const status: LoadStatus = failedSrc === src ? "error" : loadedSrc === src ? "loaded" : "loading";

    const description = caption !== undefined && caption !== "" ? caption : alt !== "" ? alt : "Image viewer";

    return (
        <Dialog.Root
            open={open}
            onOpenChange={onOpenChange}
            onOpenChangeComplete={(nextOpen) => {
                if (!nextOpen) {
                    setFailedSrc(null);
                }
            }}
        >
            <Dialog.Portal>
                <Dialog.Backdrop data-slot="image-viewer-backdrop" className={styles.backdrop} />
                <Dialog.Popup
                    ref={popupRef}
                    data-slot="image-viewer"
                    className={cn(styles.popup, className)}
                    initialFocus={popupRef}
                    tabIndex={-1}
                >
                    <Dialog.Title className={styles.srOnly}>Image viewer</Dialog.Title>
                    <Dialog.Description className={styles.srOnly}>{description}</Dialog.Description>

                    <div className={styles.topbar}>
                        <div className={styles.closeSurface}>
                            <Dialog.Close
                                render={
                                    <IconButton label="Close" radius="full">
                                        <X />
                                    </IconButton>
                                }
                            />
                        </div>
                    </div>

                    <div className={styles.stage} data-slot="image-viewer-stage">
                        {status === "error" ? (
                            <div className={styles.error} role="alert" data-slot="image-viewer-error">
                                <Icon size="lg">
                                    <ImageOff />
                                </Icon>
                                <span>Image could not be loaded.</span>
                            </div>
                        ) : (
                            <TransformWrapper
                                minScale={1}
                                maxScale={5}
                                limitToBounds
                                smooth={false}
                                wheel={{ step: 0.15 }}
                                panning={{ velocityDisabled: true }}
                                keyboard={{ disabled: false, panStep: 32, zoomStep: 0.15, animationTime: 0 }}
                                doubleClick={{ mode: "toggle", step: 1, animationTime: 0 }}
                                zoomAnimation={{ disabled: true }}
                                autoAlignment={{ disabled: true }}
                                velocityAnimation={{ disabled: true }}
                            >
                                <TransformComponent
                                    wrapperClass={styles.canvas ?? ""}
                                    contentClass={styles.content ?? ""}
                                    wrapperStyle={{ width: "100%", height: "100%" }}
                                    contentStyle={{ width: "100%", height: "100%" }}
                                    wrapperProps={{
                                        role: "region",
                                        "aria-label": "Image canvas. Use arrow keys to pan and plus or minus to zoom.",
                                    }}
                                >
                                    <img
                                        key={src}
                                        src={src}
                                        alt={alt}
                                        draggable={false}
                                        data-slot="image-viewer-image"
                                        data-status={status}
                                        className={styles.image}
                                        onLoad={() => {
                                            setFailedSrc(null);
                                            setLoadedSrc(src);
                                        }}
                                        onError={() => {
                                            setLoadedSrc(null);
                                            setFailedSrc(src);
                                        }}
                                    />
                                </TransformComponent>

                                {status === "loading" ? (
                                    <div className={styles.status} data-slot="image-viewer-loading">
                                        Loading image...
                                    </div>
                                ) : null}

                                {status === "loaded" ? <ViewerFooter caption={caption} /> : null}
                            </TransformWrapper>
                        )}
                    </div>
                </Dialog.Popup>
            </Dialog.Portal>
        </Dialog.Root>
    );
}

function ViewerFooter({ caption }: { caption: string | undefined }) {
    const scale = useTransformComponent(({ state }) => state.scale);
    const { zoomIn, zoomOut, resetTransform } = useControls();

    return (
        <div className={styles.footer} data-slot="image-viewer-footer">
            {caption === undefined || caption === "" ? null : (
                <p className={styles.caption} data-slot="image-viewer-caption">
                    {caption}
                </p>
            )}
            <div className={styles.toolbar} data-slot="image-viewer-toolbar">
                <span className={styles.zoom} data-slot="image-viewer-zoom" role="status" aria-live="polite">
                    {Math.round(scale * 100)}%
                </span>
                <IconButton
                    label="Zoom out"
                    radius="full"
                    onClick={() => {
                        void zoomOut();
                    }}
                >
                    <Minus />
                </IconButton>
                <IconButton
                    label="Zoom in"
                    radius="full"
                    onClick={() => {
                        void zoomIn();
                    }}
                >
                    <Plus />
                </IconButton>
                <IconButton
                    label="Reset zoom"
                    radius="full"
                    onClick={() => {
                        void resetTransform(0);
                    }}
                >
                    <RotateCcw />
                </IconButton>
            </div>
        </div>
    );
}
