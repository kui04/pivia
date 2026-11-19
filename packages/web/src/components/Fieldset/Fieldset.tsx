import { Fieldset as BaseFieldset } from "@base-ui/react/fieldset";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";

import styles from "./Fieldset.module.css";

type BaseFieldsetProps = Omit<ComponentProps<typeof BaseFieldset.Root>, "children">;

export type FieldsetProps = BaseFieldsetProps & {
    /** Legend that names the group of controls. */
    legend: ReactNode;
    /** The related fields. */
    children: ReactNode;
    /** Styles the fieldset element. */
    className?: string | undefined;
    /** Styles the legend. */
    legendClassName?: string | undefined;
};

/**
 * A group of related fields built on Base UI Fieldset. The legend supplies the
 * accessible group name; a disabled fieldset disables Field descendants through
 * Base UI's context.
 */
export function Fieldset({ legend, children, className, legendClassName, ...props }: FieldsetProps) {
    return (
        <BaseFieldset.Root {...props} data-slot="fieldset" className={cn(styles.fieldset, className)}>
            <BaseFieldset.Legend data-slot="fieldset-legend" className={cn(styles.legend, legendClassName)}>
                {legend}
            </BaseFieldset.Legend>
            <div className={styles.content}>{children}</div>
        </BaseFieldset.Root>
    );
}
