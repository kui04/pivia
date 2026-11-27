import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps } from "react";

import { cn } from "@/lib";

import radiusStyles from "@/styles/radius.module.css";

import styles from "./Button.module.css";

type BaseButtonProps = Omit<ComponentProps<typeof BaseButton>, "className">;

const radiusClasses = {
    none: radiusStyles.radiusNone,
    "extra-small": radiusStyles.radiusExtraSmall,
    small: radiusStyles.radiusSmall,
    medium: radiusStyles.radiusMedium,
    large: radiusStyles.radiusLarge,
    full: radiusStyles.radiusFull,
} as const;

export type ButtonVariant = "primary" | "secondary" | "ghost";

export type ButtonSize = "md" | "lg";

export type ButtonRadius = keyof typeof radiusClasses;

export type ButtonProps = BaseButtonProps & {
    /** Emphasis of the action. Defaults to `primary`. */
    variant?: ButtonVariant;
    /** Size preset. `lg` uses larger type and padding for a prominent action. */
    size?: ButtonSize;
    /** Border radius from the shape scale. Defaults to the 8px small corner. */
    radius?: ButtonRadius;
    /** Styles the button element. */
    className?: string | undefined;
};

/**
 * A native button built on Base UI Button. It keeps the button semantics, the
 * `render` composition and the disabled behaviour; this wrapper owns the
 * emphasis, the type and padding preset, and the radius.
 */
export function Button({ variant = "primary", size = "md", radius = "small", className, ...props }: ButtonProps) {
    return (
        <BaseButton
            {...props}
            data-slot="button"
            data-variant={variant}
            data-size={size}
            className={cn(styles.button, radiusClasses[radius], className)}
        />
    );
}
