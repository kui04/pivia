import { Button } from "@base-ui/react/button";
import { Tooltip } from "@base-ui/react/tooltip";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib";

import radiusStyles from "@/styles/radius.module.css";

import { Icon, type IconSize } from "../Icon";
import styles from "./IconButton.module.css";

const radiusClasses = {
    none: radiusStyles.radiusNone,
    "extra-small": radiusStyles.radiusExtraSmall,
    small: radiusStyles.radiusSmall,
    medium: radiusStyles.radiusMedium,
    large: radiusStyles.radiusLarge,
    full: radiusStyles.radiusFull,
} as const;

export type IconButtonRadius = keyof typeof radiusClasses;

export type IconButtonProps = Omit<ComponentProps<typeof Button>, "aria-label" | "children" | "className"> & {
    /** Accessible name; an icon-only button has no visible text. It is also the tooltip text. */
    label: string;
    /** Icon box size. `md` is 24px, the smallest comfortable pointer target; `sm` is a 12px glyph in a 16px box; `no-container` is a bare 16px glyph. */
    size?: IconSize;
    /** Border radius from the shape scale. Defaults to the 4px extra-small corner. */
    radius?: IconButtonRadius;
    /** Glyph element, usually a Lucide icon. It is wrapped in Icon. */
    children: ReactNode;
    className?: string | undefined;
};

/**
 * An icon-only button built on the Base UI Button and Tooltip, so button
 * semantics, `render` composition and the hover/focus tooltip come from there.
 * The glyph always goes through Icon, and `aria-pressed` paints the toggle state.
 */
export function IconButton({
    label,
    size = "md",
    radius = "extra-small",
    children,
    className,
    ...props
}: IconButtonProps) {
    return (
        <Tooltip.Root>
            <Tooltip.Trigger
                render={
                    <Button
                        aria-label={label}
                        className={cn(styles.button, radiusClasses[radius], className)}
                        {...props}
                    />
                }
            >
                <Icon size={size}>{children}</Icon>
            </Tooltip.Trigger>
            <Tooltip.Portal>
                <Tooltip.Positioner sideOffset={4} className={styles.positioner}>
                    <Tooltip.Popup className={styles.tooltip}>{label}</Tooltip.Popup>
                </Tooltip.Positioner>
            </Tooltip.Portal>
        </Tooltip.Root>
    );
}
