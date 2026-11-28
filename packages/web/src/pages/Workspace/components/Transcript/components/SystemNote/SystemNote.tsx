import { Archive } from "lucide-react";
import { memo, type ReactElement } from "react";

import { Markdown } from "@components";
import { cn } from "@/lib";
import { formatSystemNoteMeta, type TranscriptNoteItem } from "@/stores/session";

import { CollapsibleBlock } from "../CollapsibleBlock";
import styles from "./SystemNote.module.css";

/** Props of {@link SystemNote}. */
export type SystemNoteProps = {
    /** Note projected from a compaction or branch summary entry. */
    item: TranscriptNoteItem;
    /** Forwarded to Markdown links inside the summary. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * A system checkpoint between prompts, such as a compaction or branch summary.
 *
 * It shares the thinking block shell: collapsed by default with a clickable label, and the summary
 * scrolls inside a bounded panel once opened instead of dominating the conversation. Optional
 * compaction token counts and summary billing totals sit beneath the header so they stay scannable
 * before opening.
 *
 * @param props - Note item and an optional class for the surrounding row.
 */
function SystemNoteInner({ item, onOpenLink, className }: SystemNoteProps): ReactElement {
    const meta = formatSystemNoteMeta(item);

    return (
        <div className={cn(styles.root, className)}>
            <CollapsibleBlock label={item.title} icon={Archive} scrollLabel={`${item.title} details`}>
                <Markdown onOpenLink={onOpenLink}>{item.text}</Markdown>
            </CollapsibleBlock>
            {meta !== null ? <p className={styles.meta}>{meta}</p> : null}
        </div>
    );
}

/** Memoized system note: an unchanged checkpoint skips rendering on every streamed token. */
export const SystemNote = memo(SystemNoteInner);
