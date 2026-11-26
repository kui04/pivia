import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

import { Markdown } from "@components";
import type { TranscriptSkillItem } from "@/stores/session";

import { CollapsibleBlock } from "../CollapsibleBlock";
import styles from "./SkillInvocationBlock.module.css";

/** Props of {@link SkillInvocationBlock}. */
export type SkillInvocationBlockProps = {
    /** Skill invocation projected from one expanded user message. */
    item: TranscriptSkillItem;
    /** Forwarded to Markdown links inside the skill body. */
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
 * Collapsed card for one `/skill:` invocation.
 *
 * The label names the skill; expanding shows the body the model received and the file it came
 * from. It shares the thinking block shell so secondary rows keep one geometry.
 *
 * @param props - Skill item and an optional class for the surrounding row.
 */
export function SkillInvocationBlock({
    item,
    onOpenLink,
    defaultOpen = false,
    open,
    onOpenChange,
    className,
}: SkillInvocationBlockProps): ReactElement {
    return (
        <CollapsibleBlock
            label={`[skill] ${item.name}`}
            icon={Sparkles}
            scrollLabel={`${item.name} skill details`}
            tone="accent"
            defaultOpen={defaultOpen}
            open={open}
            onOpenChange={onOpenChange}
            className={className}
        >
            <Markdown onOpenLink={onOpenLink}>{item.content}</Markdown>
            <p className={styles.location}>{item.location}</p>
        </CollapsibleBlock>
    );
}
