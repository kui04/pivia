import { useState, type ReactElement } from "react";

import { Image, ImageViewer } from "@components";
import { cn } from "@/lib/cn";
import type { TranscriptUserItem } from "@/stores/session/transcript";

import styles from "./UserMessage.module.css";

/** Props of {@link UserMessage}. */
export type UserMessageProps = {
    /** User prompt (or displayed extension message) projected by the transcript model. */
    item: TranscriptUserItem;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Right-aligned prompt bubble for one user entry in the transcript.
 *
 * Attached images sit above the text bubble and open in the shared ImageViewer on click.
 *
 * @param props - Prompt item and an optional class for the surrounding row.
 */
export function UserMessage({ item, className }: UserMessageProps): ReactElement {
    const [viewer, setViewer] = useState<{ open: boolean; index: number } | null>(null);
    const hasText = item.text.trim().length > 0;
    const selectedImage = viewer !== null ? item.images[viewer.index] : undefined;

    return (
        <div className={cn(styles.root, className)}>
            {item.images.length > 0 ? (
                <div className={styles.images}>
                    {item.images.map((image, index) => {
                        const label = `Attachment ${index + 1}`;
                        return (
                            <Image
                                key={`${item.id}-image-${index}`}
                                src={`data:${image.mimeType};base64,${image.data}`}
                                alt={label}
                                openLabel={`Inspect ${label}`}
                                className={styles.imageTrigger}
                                imgClassName={styles.image}
                                onOpen={() => setViewer({ open: true, index })}
                            />
                        );
                    })}
                </div>
            ) : null}

            {hasText || item.images.length === 0 ? <div className={styles.bubble}>{item.text}</div> : null}

            {viewer !== null && selectedImage !== undefined ? (
                <ImageViewer
                    open={viewer.open}
                    onOpenChange={(open) => {
                        if (!open) {
                            setViewer((prev) => (prev === null ? null : { open: false, index: prev.index }));
                        }
                    }}
                    src={`data:${selectedImage.mimeType};base64,${selectedImage.data}`}
                    alt={`Attachment ${viewer.index + 1}`}
                />
            ) : null}
        </div>
    );
}
