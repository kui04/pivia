import { Button } from "@components";
import type { ReactElement } from "react";

import styles from "./PickerMenu.module.css";

/** Loading placeholder rows for a picker list. */
export function PickerSkeleton({
    label,
    widths,
}: {
    /** Accessible name announced while the catalog loads. */
    readonly label: string;
    /** Width of each placeholder bar, widest first. */
    readonly widths: readonly string[];
}): ReactElement {
    return (
        <div role="status" aria-label={label} className={styles.skeleton}>
            {widths.map((width, index) => (
                <div key={index} aria-hidden="true" className={styles.skeletonRow} style={{ width }} />
            ))}
        </div>
    );
}

/**
 * Error or empty-result panel inside a picker menu.
 *
 * A panel with `onRetry` is an alert, because it reports a failed load. A panel without it only
 * reports an empty result.
 */
export function PickerStatus({
    message,
    onRetry,
}: {
    readonly message: string;
    readonly onRetry?: (() => void) | undefined;
}): ReactElement {
    return (
        <div className={styles.statusBox} {...(onRetry === undefined ? {} : { role: "alert" })}>
            <p className={styles.statusText}>{message}</p>
            {onRetry === undefined ? null : (
                <Button type="button" variant="secondary" size="md" onClick={onRetry}>
                    Retry
                </Button>
            )}
        </div>
    );
}

/** Label for one option row, truncated to a single line. */
export function PickerOptionLabel({
    children,
    title,
}: {
    readonly children: string;
    /** Tooltip for a label whose full value does not fit. */
    readonly title?: string | undefined;
}): ReactElement {
    return (
        <span className={styles.optionLabel} title={title}>
            {children}
        </span>
    );
}
