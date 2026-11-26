import { Menu as BaseMenu } from "@base-ui/react/menu";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { cn } from "@/lib";

import { Icon } from "../Icon";
import { ScrollArea } from "../ScrollArea";
import styles from "./Menu.module.css";

type PositionerProps = ComponentProps<typeof BaseMenu.Positioner>;

export type MenuProps = Omit<ComponentProps<typeof BaseMenu.Root>, "children"> & {
    /**
     * Element that opens the menu. It must forward DOM props and its ref to a
     * native button; IconButton does. Base UI owns the trigger semantics.
     */
    trigger: ReactElement;
    children: ReactNode;
    /** Side of the trigger the popup opens on. Defaults to "bottom". */
    side?: PositionerProps["side"];
    /** Alignment along the trigger. Defaults to "start". */
    align?: PositionerProps["align"];
    /** Gap between the trigger and the popup in px. Defaults to 4. */
    sideOffset?: number;
    /** Class on the popup, which is portaled outside the trigger's layout. */
    className?: string | undefined;
};

/**
 * A dropdown action menu built on Base UI Menu. The caller supplies the trigger;
 * the portal, positioner, popup, items and separators use the design tokens.
 * Base UI owns keyboard navigation, typeahead, collision handling, the open
 * state and focus return. The menu is modal by default, as in Base UI.
 */
export function Menu({
    trigger,
    children,
    side = "bottom",
    align = "start",
    sideOffset = 4,
    className,
    ...props
}: MenuProps) {
    return (
        <BaseMenu.Root {...props}>
            <BaseMenu.Trigger render={trigger} />
            <BaseMenu.Portal>
                <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} className={styles.positioner}>
                    <BaseMenu.Popup data-slot="menu-popup" className={cn(styles.popup, className)}>
                        <ScrollArea
                            label="Menu"
                            className={styles.scroller}
                            viewportClassName={styles.viewport}
                            contentClassName={styles.content}
                            viewportTabIndex={-1}
                        >
                            {children}
                        </ScrollArea>
                    </BaseMenu.Popup>
                </BaseMenu.Positioner>
            </BaseMenu.Portal>
        </BaseMenu.Root>
    );
}

type BaseItemProps = Omit<ComponentProps<typeof BaseMenu.Item>, "className">;

export type MenuItemProps = BaseItemProps & {
    /** Decorative glyph or icon element. It is wrapped in Icon's 16px box. */
    icon?: ReactNode;
    /** Visual keyboard shortcut. It is hidden from the accessible name. */
    shortcut?: string;
    /** Uses the error role for an action that is destructive. */
    destructive?: boolean;
    className?: string | undefined;
};

/**
 * A command in the menu. The leading slot is always reserved so labels stay on
 * one x whether or not an item has an icon. Base UI renders the item as a
 * `menuitem`, handles activation and closes the menu on click by default.
 */
export function MenuItem({ icon, shortcut, destructive = false, className, children, ...props }: MenuItemProps) {
    return (
        <BaseMenu.Item
            data-slot="menu-item"
            className={cn(styles.item, destructive && styles.destructive, className)}
            {...props}
        >
            <span className={styles.itemIcon} aria-hidden="true">
                {icon === undefined ? null : <Icon size="no-container">{icon}</Icon>}
            </span>
            <span className={styles.itemLabel}>{children}</span>
            {shortcut === undefined ? null : (
                <kbd className={styles.shortcut} aria-hidden="true">
                    {shortcut}
                </kbd>
            )}
        </BaseMenu.Item>
    );
}

type BaseSeparatorProps = Omit<ComponentProps<typeof BaseMenu.Separator>, "className">;

export type MenuSeparatorProps = BaseSeparatorProps & {
    className?: string | undefined;
};

export function MenuSeparator({ className, ...props }: MenuSeparatorProps) {
    return <BaseMenu.Separator data-slot="menu-separator" className={cn(styles.separator, className)} {...props} />;
}
