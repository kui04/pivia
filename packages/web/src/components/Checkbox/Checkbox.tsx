import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";

import styles from "./Checkbox.module.css";

export type CheckboxProps = {
    /** Text of the option. Clicking it toggles the box. */
    label: ReactNode;
    /** Supporting text below the label. */
    description?: ReactNode;
    /** Controlled checked state. */
    checked: boolean;
    /** Runs with the next checked state. */
    onCheckedChange: (checked: boolean) => void;
    /** Prevents the toggle. */
    disabled?: boolean;
    /** Hidden input name used by a surrounding form. */
    name?: string;
    /** Styles the row. */
    className?: string | undefined;
};

/**
 * A labelled checkbox built on Base UI Checkbox. The 16px box draws its 12px
 * check directly, because an Icon box would repeat the control box. The label is
 * a real `<label>`, so the text and the box share one hit area; Base UI keeps
 * focus on the visible span, so the document focus rule draws its ring there.
 * The description sits beside the control as supporting text.
 *
 * A bare checkbox submits through the native form. `Form.onFormSubmit` only
 * collects Field-registered controls, so read the value through native
 * submission when that callback is used.
 */
export function Checkbox({
    label,
    description,
    checked,
    onCheckedChange,
    disabled = false,
    name,
    className,
}: CheckboxProps) {
    const id = useId();
    const hasDescription =
        description !== undefined && description !== null && description !== false && description !== "";
    const descriptionId = hasDescription ? `${id}-description` : undefined;

    return (
        <div className={cn(styles.row, className)} data-disabled={disabled || undefined}>
            <BaseCheckbox.Root
                id={id}
                name={name}
                checked={checked}
                onCheckedChange={(nextChecked) => {
                    onCheckedChange(nextChecked);
                }}
                disabled={disabled}
                aria-describedby={descriptionId}
                data-slot="checkbox"
                className={styles.box}
            >
                <BaseCheckbox.Indicator data-slot="checkbox-indicator" className={styles.indicator}>
                    <Check aria-hidden="true" />
                </BaseCheckbox.Indicator>
            </BaseCheckbox.Root>
            <div className={styles.text}>
                <label id={`${id}-label`} htmlFor={id} className={styles.label}>
                    {label}
                </label>
                {hasDescription ? (
                    <p id={descriptionId} className={styles.description}>
                        {description}
                    </p>
                ) : null}
            </div>
        </div>
    );
}
