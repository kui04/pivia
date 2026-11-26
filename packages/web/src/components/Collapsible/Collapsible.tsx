import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import type { ComponentProps, ReactElement } from "react";

import { cn } from "@/lib";

import styles from "./Collapsible.module.css";

export type CollapsibleProps = Omit<ComponentProps<typeof BaseCollapsible.Root>, "className"> & {
    /** Styles the collapsible root container. */
    className?: string | undefined;
};

/**
 * A collapsible region built on Base UI Collapsible.
 *
 * Compose with {@link CollapsibleTrigger} and {@link CollapsiblePanel}. Base UI owns the
 * open/closed state, `aria-expanded` and `aria-controls` wiring, panel height measurement
 * (`--collapsible-panel-height`), and unmount timing after close transitions.
 */
export function Collapsible({ className, ...props }: CollapsibleProps): ReactElement {
    return <BaseCollapsible.Root {...props} data-slot="collapsible" className={className} />;
}

export type CollapsibleTriggerProps = Omit<ComponentProps<typeof BaseCollapsible.Trigger>, "className"> & {
    /** Styles the trigger button. */
    className?: string | undefined;
};

/**
 * Button that toggles the enclosing {@link CollapsiblePanel}.
 */
export function CollapsibleTrigger({ className, ...props }: CollapsibleTriggerProps): ReactElement {
    return <BaseCollapsible.Trigger {...props} data-slot="collapsible-trigger" className={className} />;
}

export type CollapsiblePanelProps = Omit<ComponentProps<typeof BaseCollapsible.Panel>, "className"> & {
    /** Styles the animated collapsible panel. */
    className?: string | undefined;
};

/**
 * Animated content region paired with {@link CollapsibleTrigger}; unmounts while closed by default.
 */
export function CollapsiblePanel({ className, ...props }: CollapsiblePanelProps): ReactElement {
    return <BaseCollapsible.Panel {...props} data-slot="collapsible-panel" className={cn(styles.panel, className)} />;
}
