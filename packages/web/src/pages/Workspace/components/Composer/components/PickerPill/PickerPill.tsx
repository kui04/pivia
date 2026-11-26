import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "@/lib";

import styles from "./PickerPill.module.css";

export type PickerPillProps = Omit<ComponentProps<typeof BaseButton>, "className"> & {
    className?: string | undefined;
};

/**
 * Compact tinted pill button used in the composer footer for model and thinking pickers.
 */
export function PickerPill({ className, ...props }: PickerPillProps): ReactElement {
    return <BaseButton {...props} type="button" data-slot="picker-pill" className={cn(styles.pill, className)} />;
}
