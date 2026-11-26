import { Puzzle } from "lucide-react";
import type { ReactElement } from "react";

import { Markdown } from "@components";
import type { TranscriptCustomItem } from "@/stores/session";

import { CollapsibleBlock } from "../CollapsibleBlock";
import { ImageAttachments } from "../ImageAttachments";
import styles from "./CustomMessageBlock.module.css";

/** Props of {@link CustomMessageBlock}. */
export type CustomMessageBlockProps = {
    /** Extension message projected by the transcript model. */
    item: TranscriptCustomItem;
    /** Forwarded to Markdown links inside the message. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when the user toggles the block. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Collapsible row for one extension message, labeled with the `customType` that produced it.
 *
 * The label keeps the message from reading as the reader's own words, which a user bubble did
 * before. It opens by default, like the terminal client, so a message an extension sent to the
 * reader arrives visible; it shares the system-note shell so injected content keeps one compact
 * geometry, and the purple header groups it with the other injected rows. The body shows Markdown
 * and attachments through the shared viewer.
 *
 * @param props - Extension message item and optional expansion control.
 */
export function CustomMessageBlock({
    item,
    onOpenLink,
    defaultOpen = true,
    open,
    onOpenChange,
    className,
}: CustomMessageBlockProps): ReactElement {
    const label = `[${item.customType}]`;
    const hasText = item.text.trim().length > 0;

    return (
        <CollapsibleBlock
            label={label}
            icon={Puzzle}
            scrollLabel={`${item.customType} message details`}
            tone="accent"
            defaultOpen={defaultOpen}
            open={open}
            onOpenChange={onOpenChange}
            className={className}
        >
            {hasText ? <Markdown onOpenLink={onOpenLink}>{item.text}</Markdown> : null}

            {!hasText && item.images.length === 0 ? <p className={styles.placeholder}>Empty message</p> : null}

            <ImageAttachments
                images={item.images}
                label={`${label} image`}
                idPrefix={item.id}
                className={styles.images}
            />
        </CollapsibleBlock>
    );
}
