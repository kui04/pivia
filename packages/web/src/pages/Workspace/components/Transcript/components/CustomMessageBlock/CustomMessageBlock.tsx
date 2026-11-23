import { Puzzle } from "lucide-react";
import { useState, type ReactElement } from "react";

import { Image, ImageViewer, Markdown } from "@components";
import type { TranscriptCustomItem } from "@/stores/session/transcript";

import { CollapsibleBlock } from "../CollapsibleBlock/CollapsibleBlock";
import styles from "./CustomMessageBlock.module.css";

/** Props of {@link CustomMessageBlock}. */
export type CustomMessageBlockProps = {
    /** Extension message projected by the transcript model. */
    item: TranscriptCustomItem;
    /** Forwarded to Markdown links inside the message. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Collapsed row for one extension message, labeled with the `customType` that produced it.
 *
 * The label keeps the message from reading as the reader's own words, which a user bubble did
 * before. It shares the system-note shell so injected content keeps one compact geometry, and the
 * purple header groups it with the other injected rows; expanding shows the text as Markdown and
 * the attachments through the shared ImageViewer.
 *
 * @param props - Extension message item and an optional class for the surrounding row.
 */
export function CustomMessageBlock({ item, onOpenLink, className }: CustomMessageBlockProps): ReactElement {
    const [viewer, setViewer] = useState<{ open: boolean; index: number } | null>(null);
    const label = `[${item.customType}]`;
    const hasText = item.text.trim().length > 0;
    const selectedImage = viewer !== null ? item.images[viewer.index] : undefined;

    return (
        <CollapsibleBlock
            label={label}
            icon={Puzzle}
            scrollLabel={`${item.customType} message details`}
            tone="accent"
            className={className}
        >
            {hasText ? <Markdown {...(onOpenLink !== undefined ? { onOpenLink } : {})}>{item.text}</Markdown> : null}

            {item.images.length > 0 ? (
                <div className={styles.images}>
                    {item.images.map((image, index) => {
                        const alt = `${label} image ${index + 1}`;
                        return (
                            <Image
                                key={`${item.id}-image-${index}`}
                                src={`data:${image.mimeType};base64,${image.data}`}
                                alt={alt}
                                openLabel={`Inspect ${alt}`}
                                className={styles.imageTrigger}
                                imgClassName={styles.image}
                                onOpen={() => setViewer({ open: true, index })}
                            />
                        );
                    })}
                </div>
            ) : null}

            {viewer !== null && selectedImage !== undefined ? (
                <ImageViewer
                    open={viewer.open}
                    onOpenChange={(open) => {
                        if (!open) {
                            setViewer((prev) => (prev === null ? null : { open: false, index: prev.index }));
                        }
                    }}
                    src={`data:${selectedImage.mimeType};base64,${selectedImage.data}`}
                    alt={`${label} image ${viewer.index + 1}`}
                />
            ) : null}
        </CollapsibleBlock>
    );
}
