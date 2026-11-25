import { useId, useState } from "react";

/** Expanded state and ARIA wiring shared by transcript disclosure rows. */
export type DisclosureControl = {
    readonly open: boolean;
    readonly toggle: () => void;
    readonly panelId: string;
};

/** Options of {@link useDisclosure}. */
export type UseDisclosureOptions = {
    /** Initial expanded state for uncontrolled usage. */
    readonly defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    readonly open?: boolean | undefined;
    /** Called when the user toggles the row. */
    readonly onOpenChange?: ((open: boolean) => void) | undefined;
};

/**
 * Drive one disclosure row's expanded state and its panel id.
 *
 * A controlled row reports the requested state but keeps the caller's value; an uncontrolled row
 * owns the state. Both share the id that links the trigger to its panel.
 */
export function useDisclosure({
    defaultOpen = false,
    open: controlledOpen,
    onOpenChange,
}: UseDisclosureOptions = {}): DisclosureControl {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const panelId = useId();
    const open = controlledOpen ?? uncontrolledOpen;

    const toggle = (): void => {
        const next = !open;
        if (controlledOpen === undefined) {
            setUncontrolledOpen(next);
        }
        onOpenChange?.(next);
    };

    return { open, toggle, panelId };
}
