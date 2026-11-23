import { ChevronRight, type LucideIcon } from "lucide-react";
import { useId, useState, type ReactElement, type ReactNode } from "react";

import { Icon, ScrollArea } from "@components";
import { cn } from "@/lib/cn";

import { useAutoScroll } from "../../useAutoScroll";
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
 * One secondary collapsible row in a turn timeline.
 *
 * It stays collapsed by default so completed steps keep the turn compact, and its body scrolls
 * inside a bounded viewport that follows the bottom edge while the content streams. Thinking
 * blocks and system notes share this shell so their geometry, fades and focus behaviour stay in
 * sync.
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
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const panelId = useId();
    const open = controlledOpen ?? uncontrolledOpen;

    const { viewportRef, fadeTop, fadeBottom } = useAutoScroll({ enabled: open, streaming });

    const handleToggle = () => {
        const next = !open;
        if (controlledOpen === undefined) {
            setUncontrolledOpen(next);
        }
        onOpenChange?.(next);
    };

    return (
        <div className={cn(styles.root, className)} data-tone={tone}>
            <button
                type="button"
                className={styles.trigger}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={handleToggle}
            >
                <Icon size="no-container" className={styles.icon}>
                    <LeadingIcon strokeWidth={1.75} />
                </Icon>
                <span className={styles.label} data-streaming={streaming ? "true" : undefined}>
                    {label}
                </span>
                <Icon size="no-container" className={styles.chevron} data-open={open ? "true" : undefined}>
                    <ChevronRight strokeWidth={1.75} />
                </Icon>
            </button>

            <div id={panelId} className={styles.collapse} data-open={open ? "true" : undefined}>
                <div className={styles.collapseInner} inert={!open} aria-hidden={!open}>
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
                            viewportClassName={cn(
                                styles.viewport,
                                fadeTop && styles.fadeTop,
                                fadeBottom && styles.fadeBottom,
                            )}
                            contentClassName={styles.content}
                        >
                            <div className={styles.contentBody}>{children}</div>
                        </ScrollArea>
                    </div>
                </div>
            </div>
        </div>
    );
}
