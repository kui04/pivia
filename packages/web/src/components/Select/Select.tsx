import { Select as BaseSelect } from "@base-ui/react/select";
import { Check, ChevronDown } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib";

import { Icon } from "../Icon/Icon";
import styles from "./Select.module.css";

export type SelectOption = {
    value: string;
    label: ReactNode;
    disabled?: boolean | undefined;
};

export type SelectProps = {
    /** Options in display order. */
    options: readonly SelectOption[];
    /** Text shown when no value is selected. */
    placeholder?: string;
    /** Controlled selected value. */
    value?: string | null;
    /** Initial selected value when uncontrolled. */
    defaultValue?: string | null;
    /** Runs with the next selected value; null means no selection. */
    onValueChange?: ((value: string | null) => void) | undefined;
    /** Hidden input name used by a surrounding form. Field's name takes precedence. */
    name?: string;
    disabled?: boolean;
    required?: boolean;
    readOnly?: boolean;
    /** Whether the popup locks interaction with the rest of the page. Defaults to false. */
    modal?: boolean;
    /** Accessible name when the Select is used without Field. */
    ariaLabel?: string;
    /** Styles the trigger. */
    className?: string | undefined;
};

/**
 * A single-select control built on Base UI Select. Wrap it in Field for a
 * visible label, description and error. The selected label comes from
 * `options`, the hidden input can submit with a form, and the popup is
 * non-modal by default so it can sit inside a Dialog.
 */
export function Select({
    options,
    placeholder = "Select an option",
    value,
    defaultValue,
    onValueChange,
    name,
    disabled = false,
    required = false,
    readOnly = false,
    modal = false,
    ariaLabel,
    className,
}: SelectProps) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [triggerLabelledBy, setTriggerLabelledBy] = useState<string | undefined>(undefined);

    const syncTriggerLabel = (open: boolean): void => {
        if (!open) {
            return;
        }

        // Base UI labels the trigger from Field, but its listbox has no name of its own.
        // Copy the trigger's label reference so the open popup is named as well.
        setTriggerLabelledBy(triggerRef.current?.getAttribute("aria-labelledby") ?? undefined);
    };

    return (
        <BaseSelect.Root
            items={options}
            value={value}
            defaultValue={defaultValue}
            onValueChange={(nextValue) => {
                onValueChange?.(nextValue);
            }}
            onOpenChange={(open) => {
                syncTriggerLabel(open);
            }}
            name={name}
            disabled={disabled}
            required={required}
            readOnly={readOnly}
            modal={modal}
        >
            <BaseSelect.Trigger
                ref={triggerRef}
                aria-label={ariaLabel}
                data-slot="select-trigger"
                className={cn(styles.trigger, className)}
            >
                <BaseSelect.Value data-slot="select-value" className={styles.value} placeholder={placeholder} />
                <BaseSelect.Icon data-slot="select-icon" className={styles.chevron}>
                    <Icon size="no-container">
                        <ChevronDown />
                    </Icon>
                </BaseSelect.Icon>
            </BaseSelect.Trigger>
            <BaseSelect.Portal>
                <BaseSelect.Positioner alignItemWithTrigger={false} sideOffset={4} className={styles.positioner}>
                    <BaseSelect.Popup data-slot="select-popup" className={styles.popup}>
                        <BaseSelect.List
                            aria-labelledby={triggerLabelledBy}
                            aria-label={triggerLabelledBy === undefined ? ariaLabel : undefined}
                            data-slot="select-list"
                            className={styles.list}
                        >
                            {options.map((option) => (
                                <BaseSelect.Item
                                    key={option.value}
                                    value={option.value}
                                    disabled={option.disabled}
                                    data-slot="select-item"
                                    className={styles.item}
                                >
                                    <BaseSelect.ItemText data-slot="select-item-text" className={styles.itemText}>
                                        {option.label}
                                    </BaseSelect.ItemText>
                                    <span className={styles.indicatorSlot}>
                                        <BaseSelect.ItemIndicator
                                            data-slot="select-item-indicator"
                                            className={styles.indicator}
                                        >
                                            <Icon size="no-container">
                                                <Check />
                                            </Icon>
                                        </BaseSelect.ItemIndicator>
                                    </span>
                                </BaseSelect.Item>
                            ))}
                        </BaseSelect.List>
                    </BaseSelect.Popup>
                </BaseSelect.Positioner>
            </BaseSelect.Portal>
        </BaseSelect.Root>
    );
}
