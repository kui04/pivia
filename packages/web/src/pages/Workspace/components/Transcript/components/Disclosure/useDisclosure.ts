import { useCallback, useState } from "react";

/** Options of {@link useDisclosure}. */
export type UseDisclosureOptions = {
    /** Initial expanded state for uncontrolled usage. */
    readonly defaultOpen?: boolean | undefined;
    /** Controlled expanded state. */
    readonly open?: boolean | undefined;
    /** Called when Base UI reports an open-state change. */
    readonly onOpenChange?: ((open: boolean) => void) | undefined;
};

/**
 * Mirror Base UI `Collapsible` open state for callers whose scroll observers or lazy formatting
 * depend on whether the panel is currently open.
 */
export function useDisclosure({ defaultOpen = false, open: controlledOpen, onOpenChange }: UseDisclosureOptions = {}): {
    readonly open: boolean;
    readonly onOpenChange: (nextOpen: boolean) => void;
} {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;

    const handleOpenChange = useCallback(
        (nextOpen: boolean) => {
            if (!isControlled) {
                setUncontrolledOpen(nextOpen);
            }
            onOpenChange?.(nextOpen);
        },
        [isControlled, onOpenChange],
    );

    return { open, onOpenChange: handleOpenChange };
}
