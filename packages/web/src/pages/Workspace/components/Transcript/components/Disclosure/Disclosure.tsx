import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger, Icon } from "@components";
import { cn } from "@/lib";

import styles from "./Disclosure.module.css";

/** Props of {@link Disclosure}. */
export type DisclosureProps = {
    /** Leading decorative icon. */
    icon: LucideIcon;
    /** Primary row text; it is also the trigger's accessible name. */
    label: string;
    /** Secondary text that takes the remaining row width, such as a tool's argument summary. */
    summary?: string | undefined;
    /** Trailing text before the chevron, such as a tool's elapsed time. */
    meta?: ReactNode | undefined;
    /** True while the trailing meta still updates; marks it with `data-running` for stories. */
    metaRunning?: boolean | undefined;
    /** Color role of the row; `primary` keeps the label accent, `error` marks a failed call. */
    tone?: "neutral" | "accent" | "primary" | "error" | undefined;
    /** True while the label still streams; animates the label text. */
    streaming?: boolean | undefined;
    /** Initial expanded state for uncontrolled usage. */
    defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    open?: boolean | undefined;
    /** Called when Base UI toggles the row. */
    onOpenChange?: ((open: boolean) => void) | undefined;
    /** Optional class name on the outer container. */
    className?: string | undefined;
    /** Panel body. The caller owns its layout and any bounded scroller. */
    children: ReactNode;
};

/**
 * Shared disclosure shell for transcript rows: trigger and animated Base UI collapsible panel.
 *
 * The header owns the icon, label, optional summary and trailing meta. Base UI `Collapsible` owns
 * the open/closed ARIA wiring, height transition and unmount lifecycle. Callers supply the body, so
 * a thinking block can scroll its Markdown while a turn group lays out its timeline.
 */
export function Disclosure({
    icon: LeadingIcon,
    label,
    summary,
    meta,
    metaRunning = false,
    tone = "neutral",
    streaming = false,
    defaultOpen,
    open,
    onOpenChange,
    className,
    children,
}: DisclosureProps): ReactElement {
    return (
        <Collapsible
            open={open}
            defaultOpen={defaultOpen}
            onOpenChange={(nextOpen) => {
                onOpenChange?.(nextOpen);
            }}
            className={cn(styles.root, className)}
            data-tone={tone}
        >
            <CollapsibleTrigger className={styles.trigger}>
                <Icon size="no-container" className={styles.icon}>
                    <LeadingIcon strokeWidth={1.75} />
                </Icon>
                <span className={styles.label} data-streaming={streaming ? "true" : undefined}>
                    {label}
                </span>
                {summary !== undefined ? <span className={styles.summary}>{summary}</span> : null}
                {meta !== undefined ? (
                    <span className={styles.meta} data-running={metaRunning ? "true" : undefined}>
                        {meta}
                    </span>
                ) : null}
                <Icon size="no-container" className={styles.chevron}>
                    <ChevronRight strokeWidth={1.75} />
                </Icon>
            </CollapsibleTrigger>

            <CollapsiblePanel>{children}</CollapsiblePanel>
        </Collapsible>
    );
}
