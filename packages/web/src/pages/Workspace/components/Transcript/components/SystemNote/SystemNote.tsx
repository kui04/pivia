import { Layers } from "lucide-react";
import type { ReactElement } from "react";

import { Markdown } from "@components";
import type { TranscriptNoteItem } from "@/stores/session/transcript";

import { CollapsibleBlock } from "../CollapsibleBlock/CollapsibleBlock";

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
 * scrolls inside a bounded panel once opened instead of dominating the conversation.
 *
 * @param props - Note item and an optional class for the surrounding row.
 */
export function SystemNote({ item, onOpenLink, className }: SystemNoteProps): ReactElement {
    return (
        <CollapsibleBlock label={item.title} icon={Layers} scrollLabel={`${item.title} details`} className={className}>
            <Markdown {...(onOpenLink !== undefined ? { onOpenLink } : {})}>{item.text}</Markdown>
        </CollapsibleBlock>
    );
}
