import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Icon } from "@components";
import { cn } from "@/lib";

import styles from "./Disclosure.module.css";
import type { DisclosureControl } from "./useDisclosure";

/** Props of {@link Disclosure}. */
export type DisclosureProps = {
    /** Expanded state returned by {@link useDisclosure}. */
    control: DisclosureControl;
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
    /** Optional class name on the outer container. */
    className?: string | undefined;
    /** Panel body. The caller owns its layout and any bounded scroller. */
    children: ReactNode;
};

/**
 * Shared disclosure shell for transcript rows: trigger, animated panel and inert wiring.
 *
 * The header owns the icon, label, optional summary and trailing meta. The panel animates from
 * `0fr` to `1fr` and stays inert while closed. Callers supply the body, so a thinking block can
 * scroll its Markdown while a turn group lays out its timeline.
 */
export function Disclosure({
    control,
    icon: LeadingIcon,
    label,
    summary,
    meta,
    metaRunning = false,
    tone = "neutral",
    streaming = false,
    className,
    children,
}: DisclosureProps): ReactElement {
    const { open, toggle, panelId } = control;

    return (
        <div className={cn(styles.root, className)} data-tone={tone}>
            <button
                type="button"
                className={styles.trigger}
                aria-expanded={open}
                aria-controls={panelId}
                onClick={toggle}
            >
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
                <Icon size="no-container" className={styles.chevron} data-open={open ? "true" : undefined}>
                    <ChevronRight strokeWidth={1.75} />
                </Icon>
            </button>

            <div id={panelId} className={styles.collapse} data-open={open ? "true" : undefined}>
                <div className={styles.collapseInner} inert={!open} aria-hidden={!open}>
                    {children}
                </div>
            </div>
        </div>
    );
}
