import type { ReactElement } from "react";

import { LoadingIndicator, type IconSize } from "@components";
import { cn } from "@/lib";

import styles from "./WorkingIndicator.module.css";

/** Props of {@link WorkingIndicator}. */
export type WorkingIndicatorProps = {
    /** Visible and announced status text. Defaults to "Working...". */
    label?: string | undefined;
    /** Spinner box and glyph preset shared with Icon. Defaults to "no-container". */
    size?: IconSize | undefined;
    /** Optional class name on the status row. */
    className?: string | undefined;
};

/**
 * The activity row shown while the model is working inside a turn.
 *
 * The spinner is decorative and hidden from assistive technology; the `status` text is the
 * announcement, so a screen reader reports one message instead of a progressbar and a label.
 *
 * @param props - Optional label, spinner size and row class.
 */
export function WorkingIndicator({
    label = "Working...",
    size = "no-container",
    className,
}: WorkingIndicatorProps): ReactElement {
    return (
        <div className={cn(styles.root, className)} role="status">
            <LoadingIndicator size={size} aria-hidden="true" />
            <span className={styles.label}>{label}</span>
        </div>
    );
}
