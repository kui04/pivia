import { Progress as BaseProgress } from "@base-ui/react/progress";
import type { ComponentProps } from "react";

import { cn } from "@/lib";

import { Icon, type IconSize } from "../Icon";
import styles from "./LoadingIndicator.module.css";

type BaseProgressRootProps = Omit<
    ComponentProps<typeof BaseProgress.Root>,
    | "aria-label"
    | "aria-valuemax"
    | "aria-valuemin"
    | "aria-valuenow"
    | "aria-valuetext"
    | "children"
    | "className"
    | "format"
    | "getAriaValueText"
    | "locale"
    | "max"
    | "min"
    | "render"
    | "role"
    | "value"
>;

export type LoadingIndicatorProps = BaseProgressRootProps & {
    /**
     * Accessible name for the progressbar role when `aria-labelledby` is not set.
     * Defaults to "Loading".
     */
    label?: string | undefined;
    /**
     * Box and glyph preset shared with Icon:
     * sm 16px with a 12px glyph, no-container 16px with a 16px glyph,
     * md 24px, lg 32px, xl 40px. Defaults to "md".
     */
    size?: IconSize | undefined;
    /** Styles the indicator root. */
    className?: string | undefined;
};

/**
 * An indeterminate circular loading indicator built on Base UI Progress and
 * sized with Icon so it aligns with buttons, inputs and icon rows. Base UI
 * supplies the `progressbar` role, indeterminate state attributes and the
 * screen-reader presentation node.
 */
export function LoadingIndicator({
    label,
    size = "md",
    className,
    "aria-labelledby": ariaLabelledBy,
    ...props
}: LoadingIndicatorProps) {
    const ariaLabel = ariaLabelledBy === undefined ? (label ?? "Loading") : undefined;

    return (
        <BaseProgress.Root
            {...props}
            value={null}
            aria-label={ariaLabel}
            aria-labelledby={ariaLabelledBy}
            data-slot="loading-indicator"
            data-size={size}
            render={<span />}
            className={cn(styles.root, className)}
        >
            <Icon size={size}>
                <svg viewBox="0 0 24 24" fill="none">
                    <circle className={styles.track} cx="12" cy="12" r="9.5" />
                    <g className={styles.spinner}>
                        <circle className={styles.arc} cx="12" cy="12" r="9.5" pathLength={100} />
                    </g>
                </svg>
            </Icon>
        </BaseProgress.Root>
    );
}
