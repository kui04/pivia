import { Brain } from "lucide-react";
import type { ReactElement } from "react";

import { Markdown } from "@components";
import type { TranscriptThinkingStep } from "@/stores/session/transcript";

import { CollapsibleBlock } from "../CollapsibleBlock/CollapsibleBlock";
import styles from "./ThinkingBlock.module.css";

/** Props of {@link ThinkingBlock}. */
export type ThinkingBlockProps = {
    /** Thinking step projected by the transcript model. */
    step: TranscriptThinkingStep;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when the user toggles the block. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Forwarded to Markdown links inside the thinking body. */
    onOpenLink?: ((href: string) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * Secondary collapsible container for one model reasoning block.
 *
 * It stays collapsed by default so completed steps keep the turn compact, and it streams inside a
 * bounded viewport that follows the bottom edge while the reader stays there.
 *
 * @param props - Thinking step and optional expansion control.
 */
export function ThinkingBlock({
    step,
    defaultOpen = false,
    open,
    onOpenChange,
    onOpenLink,
    className,
}: ThinkingBlockProps): ReactElement {
    const hasContent = step.thinking.trim().length > 0;

    return (
        <CollapsibleBlock
            label={step.streaming ? "Thinking..." : "Thoughts"}
            icon={Brain}
            scrollLabel="Thinking details"
            streaming={step.streaming}
            defaultOpen={defaultOpen}
            open={open}
            onOpenChange={onOpenChange}
            className={className}
        >
            {hasContent ? (
                <>
                    <Markdown streaming={step.streaming} {...(onOpenLink !== undefined ? { onOpenLink } : {})}>
                        {step.thinking}
                    </Markdown>
                    {step.redacted ? <p className={styles.placeholder}>Additional reasoning was redacted.</p> : null}
                </>
            ) : (
                <p className={styles.placeholder}>
                    {step.redacted ? "Reasoning was redacted by the provider." : "Thinking..."}
                </p>
            )}
        </CollapsibleBlock>
    );
}
