import { Popover, PopoverContent, PopoverTrigger } from "@components";
import { cn } from "@/lib";
import type { ReactElement, ReactNode } from "react";

import { PickerPill } from "../PickerPill";
import pickerStyles from "./PickerMenu.module.css";

export interface PickerPopoverProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly disabled: boolean;
    /** Accessible name of the trigger pill, such as "Model: Claude Sonnet 4". */
    readonly label: string;
    /** Tooltip of the trigger pill. */
    readonly title?: string | undefined;
    /** Pill sizing for this picker. */
    readonly pillClassName?: string | undefined;
    /** Popup sizing for this picker; the shared popup class is added here. */
    readonly popupClassName?: string | undefined;
    readonly triggerChildren: ReactNode;
    readonly children: ReactNode;
}

/**
 * Trigger pill and upward popover shared by the composer pickers.
 *
 * The popup opens above the composer and shifts horizontally to stay on screen, so a narrow
 * viewport does not flip it over the transcript.
 */
export function PickerPopover({
    open,
    onOpenChange,
    disabled,
    label,
    title,
    pillClassName,
    popupClassName,
    triggerChildren,
    children,
}: PickerPopoverProps): ReactElement {
    return (
        <Popover open={open && !disabled} onOpenChange={onOpenChange}>
            <PopoverTrigger
                render={<PickerPill aria-label={label} disabled={disabled} className={pillClassName} title={title} />}
            >
                {triggerChildren}
            </PopoverTrigger>
            <PopoverContent
                side="top"
                align="start"
                sideOffset={10}
                collisionAvoidance={{ side: "none", align: "shift" }}
                className={cn(pickerStyles.popup, popupClassName)}
            >
                {children}
            </PopoverContent>
        </Popover>
    );
}
