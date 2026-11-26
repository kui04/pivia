import { Popover as BasePopover } from "@base-ui/react/popover";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { cn } from "@/lib";

import styles from "./Popover.module.css";

type RootProps = Omit<ComponentProps<typeof BasePopover.Root>, "children">;
type TriggerProps = Omit<ComponentProps<typeof BasePopover.Trigger>, "className">;
type PositionerProps = ComponentProps<typeof BasePopover.Positioner>;
type PopupProps = Omit<ComponentProps<typeof BasePopover.Popup>, "className">;
type PortalProps = ComponentProps<typeof BasePopover.Portal>;
type TitleProps = Omit<ComponentProps<typeof BasePopover.Title>, "className">;
type DescriptionProps = Omit<ComponentProps<typeof BasePopover.Description>, "className">;
type CloseProps = Omit<ComponentProps<typeof BasePopover.Close>, "className">;

export type PopoverChangeEventDetails = BasePopover.Root.ChangeEventDetails;

export type PopoverProps = RootProps & {
    /** Popover trigger and content composition. */
    children: ReactNode;
};

export type PopoverTriggerProps = TriggerProps & {
    className?: string | undefined;
};

export type PopoverContentProps = PopupProps & {
    /** Side of the anchor where the popup opens. Defaults to `"bottom"`. */
    side?: PositionerProps["side"];
    /** Alignment along the anchor. Defaults to `"center"`. */
    align?: PositionerProps["align"];
    /** Distance in pixels between the anchor and the popup. Defaults to `8`. */
    sideOffset?: PositionerProps["sideOffset"];
    /** Offset along the alignment axis in pixels. */
    alignOffset?: PositionerProps["alignOffset"];
    /** Collision handling strategy on the side and alignment axes. */
    collisionAvoidance?: PositionerProps["collisionAvoidance"];
    /** Optional explicit positioning anchor. */
    anchor?: PositionerProps["anchor"];
    /** Keeps the portal mounted while closed. */
    keepMounted?: PortalProps["keepMounted"];
    /** Styles the popup surface. */
    className?: string | undefined;
    /** Styles the positioner wrapper. */
    positionerClassName?: string | undefined;
};

export type PopoverTitleProps = TitleProps & {
    className?: string | undefined;
};

export type PopoverDescriptionProps = DescriptionProps & {
    className?: string | undefined;
};

export type PopoverCloseProps = CloseProps & {
    className?: string | undefined;
};

/**
 * Root container for an anchored non-modal popover built on Base UI Popover.
 */
export function Popover({ children, ...props }: PopoverProps): ReactElement {
    return <BasePopover.Root {...props}>{children}</BasePopover.Root>;
}

/**
 * Trigger or anchor element for an enclosing {@link Popover}.
 */
export function PopoverTrigger({ className, ...props }: PopoverTriggerProps): ReactElement {
    return (
        <BasePopover.Trigger
            {...props}
            data-slot="popover-trigger"
            {...(className === undefined ? {} : { className })}
        />
    );
}

/**
 * Portaled, positioned popup surface for an enclosing {@link Popover}.
 */
export function PopoverContent({
    side = "bottom",
    align = "center",
    sideOffset = 8,
    alignOffset,
    collisionAvoidance,
    anchor,
    keepMounted,
    className,
    positionerClassName,
    children,
    ...props
}: PopoverContentProps): ReactElement {
    return (
        <BasePopover.Portal {...(keepMounted === undefined ? {} : { keepMounted })}>
            <BasePopover.Positioner
                side={side}
                align={align}
                sideOffset={sideOffset}
                {...(alignOffset === undefined ? {} : { alignOffset })}
                {...(collisionAvoidance === undefined ? {} : { collisionAvoidance })}
                {...(anchor === undefined ? {} : { anchor })}
                className={cn(styles.positioner, positionerClassName)}
            >
                <BasePopover.Popup {...props} data-slot="popover" className={cn(styles.popup, className)}>
                    {children}
                </BasePopover.Popup>
            </BasePopover.Positioner>
        </BasePopover.Portal>
    );
}

/**
 * Accessible heading inside a {@link PopoverContent}.
 */
export function PopoverTitle({ className, ...props }: PopoverTitleProps): ReactElement {
    return (
        <BasePopover.Title {...props} data-slot="popover-title" {...(className === undefined ? {} : { className })} />
    );
}

/**
 * Accessible description inside a {@link PopoverContent}.
 */
export function PopoverDescription({ className, ...props }: PopoverDescriptionProps): ReactElement {
    return (
        <BasePopover.Description
            {...props}
            data-slot="popover-description"
            {...(className === undefined ? {} : { className })}
        />
    );
}

/**
 * Button that closes the enclosing {@link Popover}.
 */
export function PopoverClose({ className, ...props }: PopoverCloseProps): ReactElement {
    return (
        <BasePopover.Close {...props} data-slot="popover-close" {...(className === undefined ? {} : { className })} />
    );
}
