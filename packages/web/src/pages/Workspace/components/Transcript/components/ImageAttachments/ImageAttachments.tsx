import type { ReactElement } from "react";

import type { ImageContent } from "@earendil-works/pi-ai";
import { Image, ImageViewer } from "@components";
import { useImageViewer } from "@/hooks";
import { cn } from "@/lib";

import styles from "./ImageAttachments.module.css";

/** Props of {@link ImageAttachments}. */
export type ImageAttachmentsProps = {
    /** Images attached to the transcript item; an empty list renders nothing. */
    images: readonly ImageContent[];
    /** Names one attachment; the 1-based index follows it, e.g. `Attachment 2`. */
    label: string;
    /** Prefix for React keys, so repeated image indexes in one list stay unique. */
    idPrefix: string;
    /** Optional class name on the wrapped row, for spacing owned by the surrounding block. */
    className?: string | undefined;
};

/**
 * Thumbnail row that opens one attachment at a time in the shared viewer.
 *
 * Prompts and extension messages show their attachments through the same control, so a click
 * always lands on the image the reader picked instead of the first one in the row.
 *
 * @param props - Attachments, their label and the owning item id.
 */
export function ImageAttachments({ images, label, idPrefix, className }: ImageAttachmentsProps): ReactElement | null {
    const viewer = useImageViewer<number>();
    const selectedImage = viewer.selection === undefined ? undefined : images[viewer.selection];

    if (images.length === 0) {
        return null;
    }

    return (
        <>
            <div className={cn(styles.images, className)}>
                {images.map((image, index) => {
                    const name = `${label} ${index + 1}`;
                    return (
                        <Image
                            key={`${idPrefix}-image-${index}`}
                            src={`data:${image.mimeType};base64,${image.data}`}
                            alt={name}
                            openLabel={`Inspect ${name}`}
                            className={styles.imageTrigger}
                            imgClassName={styles.image}
                            onOpen={() => {
                                viewer.show(index);
                            }}
                        />
                    );
                })}
            </div>

            {viewer.selection !== undefined && selectedImage !== undefined ? (
                <ImageViewer
                    open={viewer.open}
                    onOpenChange={viewer.onOpenChange}
                    src={`data:${selectedImage.mimeType};base64,${selectedImage.data}`}
                    alt={`${label} ${viewer.selection + 1}`}
                />
            ) : null}
        </>
    );
}
