import type { ReactElement } from "react";

import { cn } from "@/lib";
import type { TranscriptUserItem } from "@/stores/session/transcript";

import { ImageAttachments } from "../ImageAttachments/ImageAttachments";
import styles from "./UserMessage.module.css";

/** Props of {@link UserMessage}. */
export type UserMessageProps = {
    /** User prompt projected by the transcript model. */
    item: TranscriptUserItem;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Right-aligned prompt bubble for one user entry in the transcript.
 *
 * Attached images sit above the text bubble and open in the shared viewer on click.
 *
 * @param props - Prompt item and an optional class for the surrounding row.
 */
export function UserMessage({ item, className }: UserMessageProps): ReactElement {
    const hasText = item.text.trim().length > 0;

    return (
        <div className={cn(styles.root, className)}>
            <ImageAttachments images={item.images} label="Attachment" idPrefix={item.id} className={styles.images} />

            {hasText || item.images.length === 0 ? <div className={styles.bubble}>{item.text}</div> : null}
        </div>
    );
}
