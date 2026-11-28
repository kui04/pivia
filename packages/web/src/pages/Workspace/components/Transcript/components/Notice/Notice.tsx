import type { LucideIcon } from "lucide-react";
import { memo, type ReactElement, type ReactNode } from "react";

import { Icon } from "@components";
import { cn } from "@/lib";

import styles from "./Notice.module.css";

/** Severity of a transcript notice: `error` colors the row; `status` stays muted. */
export type NoticeTone = "status" | "error";

/** Props of {@link Notice}. */
export type NoticeProps = {
    /** `error` colors the text and its icon; `status` stays muted. Defaults to `status`. */
    tone?: NoticeTone | undefined;
    /** Optional leading icon; it inherits the row color. */
    icon?: LucideIcon | undefined;
    /** Colors the leading icon with the warning role, as truncation and diagnostics rows do. */
    warningIcon?: boolean | undefined;
    /** Live-region role; omit for a visual-only row. */
    live?: "status" | "alert" | undefined;
    /** Optional class on the row, for caller-owned spacing or a surface. */
    className?: string | undefined;
    children: ReactNode;
};

/**
 * One transcript notice line.
 *
 * Callers own the surrounding chrome (a card surface or a bordered section under a tool output),
 * so the same two text styles fit an inline cache note, a turn footer warning and a truncation
 * warning inside a card. The live role stays explicit because one page can hold several rows, and
 * several live regions would announce over each other.
 */
export function NoticeInner({
    tone = "status",
    icon: LeadingIcon,
    warningIcon = false,
    live,
    className,
    children,
}: NoticeProps): ReactElement {
    return (
        <div className={cn(styles.notice, className)} data-tone={tone} role={live}>
            {LeadingIcon !== undefined ? (
                <Icon size="no-container" className={styles.icon} data-tone={warningIcon ? "warning" : undefined}>
                    <LeadingIcon strokeWidth={1.75} />
                </Icon>
            ) : null}
            <span className={styles.text}>{children}</span>
        </div>
    );
}

/** Memoized notice row: an unchanged notice skips rendering on every streamed token. */
export const Notice = memo(NoticeInner);
