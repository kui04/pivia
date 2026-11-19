import { Field as BaseField } from "@base-ui/react/field";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";

import styles from "./Field.module.css";

type BaseFieldProps = Omit<ComponentProps<typeof BaseField.Root>, "children" | "invalid">;

export type FieldProps = BaseFieldProps & {
    /** Visible label associated with the wrapped control. */
    label: ReactNode;
    /** Supporting text below the control. */
    description?: ReactNode;
    /** External error message. It marks the field invalid and replaces the native validation message. */
    error?: ReactNode;
    /** The control to label and validate, such as Input or Select. */
    children: ReactNode;
    /**
     * Whether the label renders as a native `<label>`. Keep true for inputs; set
     * false for button-like controls such as Select so a click does not also
     * open the control.
     */
    nativeLabel?: boolean;
    /** Marks the field invalid without showing a message. */
    invalid?: boolean | undefined;
    /** Styles the field wrapper. */
    className?: string | undefined;
};

/**
 * A labelled field built on Base UI Field. Base UI connects the label,
 * description, validation message and control, tracks dirty/filled/touched
 * state and blocks submission through a Form when native constraints fail.
 * Pass `nativeLabel={false}` for a Select trigger.
 */
export function Field({
    label,
    description,
    error,
    children,
    nativeLabel = true,
    invalid = false,
    className,
    ...props
}: FieldProps) {
    const hasDescription =
        description !== undefined && description !== null && description !== false && description !== "";
    const hasError = error !== undefined && error !== null && error !== false && error !== "";
    const labelElement = nativeLabel ? undefined : <div />;

    return (
        <BaseField.Root
            {...props}
            invalid={hasError || invalid}
            data-slot="field"
            className={cn(styles.field, className)}
        >
            <BaseField.Label
                nativeLabel={nativeLabel}
                render={labelElement}
                data-slot="field-label"
                className={styles.label}
            >
                {label}
            </BaseField.Label>
            {children}
            <div className={styles.messages} data-slot="field-messages">
                {hasDescription ? (
                    <BaseField.Description data-slot="field-description" className={styles.description}>
                        {description}
                    </BaseField.Description>
                ) : null}
                {hasError ? (
                    <BaseField.Error match={true} role="alert" data-slot="field-error" className={styles.error}>
                        {error}
                    </BaseField.Error>
                ) : (
                    <BaseField.Error role="alert" data-slot="field-error" className={styles.error} />
                )}
            </div>
        </BaseField.Root>
    );
}
