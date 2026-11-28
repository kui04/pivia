import { Radio as BaseRadio } from "@base-ui/react/radio";
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group";
import { useId, type ReactElement, type ReactNode } from "react";

import { cn } from "@/lib";

import styles from "./RadioGroup.module.css";

/** Props of the radio group root. Wrap it in `Fieldset` for a visible legend. */
export interface RadioGroupProps {
    /** One or more {@link RadioGroupItem} children. */
    readonly children: ReactNode;
    /** Controlled value of the selected item; `null` selects nothing. */
    readonly value?: string | null | undefined;
    /** Initial value when uncontrolled. */
    readonly defaultValue?: string | null | undefined;
    /** Runs with the next selected value. */
    readonly onValueChange?: ((value: string) => void) | undefined;
    /** Prevents interaction with every item. */
    readonly disabled?: boolean | undefined;
    /** Requires a selection before the surrounding form submits. */
    readonly required?: boolean | undefined;
    /** Hidden input name used by a surrounding form. */
    readonly name?: string | undefined;
    /** Accessible name when the group is used without `Fieldset`. */
    readonly ariaLabel?: string | undefined;
    /** Styles the group element. */
    readonly className?: string | undefined;
}

/** Props of one radio item. */
export interface RadioGroupItemProps {
    /** Value reported when this item is selected. */
    readonly value: string;
    /** Visible label; clicking it selects the item. */
    readonly children: ReactNode;
    /** Prevents selecting this item. */
    readonly disabled?: boolean | undefined;
    /** Styles the item row. */
    readonly className?: string | undefined;
}

/**
 * A single-select group built on Base UI Radio Group.
 *
 * Arrow keys move between items, Space selects the focused item, and the group exposes
 * `role="radiogroup"` with every label connected to its control. Callers own the confirm action,
 * so a selection never submits on its own. `value` stays controlled when the caller passes it,
 * including `null` for "nothing selected".
 */
export function RadioGroup({
    children,
    value,
    defaultValue,
    onValueChange,
    disabled,
    required,
    name,
    ariaLabel,
    className,
}: RadioGroupProps): ReactElement {
    return (
        <BaseRadioGroup<string | null>
            value={value}
            defaultValue={defaultValue}
            onValueChange={
                onValueChange === undefined
                    ? undefined
                    : (next: string | null) => {
                          if (next !== null) {
                              onValueChange(next);
                          }
                      }
            }
            disabled={disabled}
            required={required}
            name={name}
            aria-label={ariaLabel}
            data-slot="radio-group"
            className={cn(styles.group, className)}
        >
            {children}
        </BaseRadioGroup>
    );
}

/**
 * One labelled option of a {@link RadioGroup}.
 *
 * The label is a real `<label>`, so the text and the control share one hit area and focus stays on
 * the visible radio element. The label id is wired through `aria-labelledby` because a custom
 * `role="radio"` span takes no name from the wrapping label alone.
 */
export function RadioGroupItem({ value, children, disabled, className }: RadioGroupItemProps): ReactElement {
    const labelId = useId();

    return (
        <label data-slot="radio-group-item" className={cn(styles.item, className)}>
            <BaseRadio.Root value={value} disabled={disabled} aria-labelledby={labelId} className={styles.control}>
                <BaseRadio.Indicator className={styles.indicator} />
            </BaseRadio.Root>
            <span id={labelId} className={styles.label}>
                {children}
            </span>
        </label>
    );
}
