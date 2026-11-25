import type { LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { ScrollArea } from "@components";
import { cn } from "@/lib";

import { useAutoScroll } from "../../useAutoScroll";
import { Disclosure } from "../Disclosure/Disclosure";
import { useDisclosure } from "../Disclosure/useDisclosure";
import styles from "./CollapsibleBlock.module.css";

/** Props of {@link CollapsibleBlock}. */
export type CollapsibleBlockProps = {
    /** Trigger label; it is also the button's accessible name. */
    label: string;
    /** Leading decorative icon. */
    icon: LucideIcon;
    /** Accessible name of the scroll region inside the panel. */
    scrollLabel: string;
    /** True while the content still streams; animates the label and follows the bottom edge. */
    streaming?: boolean | undefined;
    /** Accent that identifies the row; `accent` uses the tertiary purple. */
    tone?: "neutral" | "accent" | undefined;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when the user toggles the block. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Content rendered inside the scroll region, usually one Markdown block. */
    children: ReactNode;
    /** Optional class name on the outer container. */
    className?: string | undefined;
};

/**
 * One secondary collapsible row with a bounded, scrollable body.
 *
 * It stays collapsed by default so completed steps keep the turn compact, and its body follows the
 * bottom edge while the content streams. Thinking blocks and system notes share this body so their
 * geometry, fades and focus behaviour stay in sync.
 *
 * @param props - Trigger label and icon, scroll-region name and panel content.
 */
export function CollapsibleBlock({
    label,
    icon: LeadingIcon,
    scrollLabel,
    streaming = false,
    defaultOpen = false,
    open: controlledOpen,
    onOpenChange,
    children,
    className,
    tone = "neutral",
}: CollapsibleBlockProps): ReactElement {
    const control = useDisclosure({ defaultOpen, open: controlledOpen, onOpenChange });
    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({ enabled: control.open, streaming });

    return (
        <Disclosure
            control={control}
            icon={LeadingIcon}
            label={label}
            tone={tone}
            streaming={streaming}
            className={className}
        >
            <div
                className={styles.body}
                data-fade-top={fadeTop ? "true" : undefined}
                data-fade-bottom={fadeBottom ? "true" : undefined}
            >
                <div className={styles.rail} aria-hidden="true" />
                <ScrollArea
                    label={scrollLabel}
                    viewportRef={viewportRef}
                    className={styles.scroll}
                    viewportClassName={cn(styles.viewport, fadeTop && styles.fadeTop, fadeBottom && styles.fadeBottom)}
                    contentClassName={styles.content}
                >
                    <div className={styles.contentBody}>{children}</div>
                </ScrollArea>
            </div>
        </Disclosure>
    );
}
