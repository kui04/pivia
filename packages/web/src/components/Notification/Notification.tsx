import { Toast as BaseToast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/cn";

import { Icon } from "../Icon/Icon";
import styles from "./Notification.module.css";

type BaseProviderProps = ComponentProps<typeof BaseToast.Provider>;

export type NotificationPosition =
    "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export type NotificationProviderProps = BaseProviderProps & {
    /** Accessible name for the live region. Defaults to "Notifications". */
    label?: string | undefined;
    /** Where the stack sits in the viewport. Defaults to "bottom-right". */
    position?: NotificationPosition;
    /** Class on the fixed viewport, which is portaled outside the app tree. */
    viewportClassName?: string | undefined;
};

/**
 * Wraps Base UI Toast and renders the single fixed viewport for the app.
 * Children call `useNotification()` to add messages. Base UI owns timers, the
 * stack limit, keyboard navigation, swipe dismissal and the live-region
 * semantics.
 */
export function NotificationProvider({
    children,
    label = "Notifications",
    position = "bottom-right",
    viewportClassName,
    ...props
}: NotificationProviderProps) {
    return (
        <BaseToast.Provider {...props}>
            {children}
            <BaseToast.Portal>
                <BaseToast.Viewport
                    data-slot="notification-viewport"
                    data-position={position}
                    aria-label={label}
                    className={cn(styles.viewport, viewportClassName)}
                >
                    <NotificationList position={position} />
                </BaseToast.Viewport>
            </BaseToast.Portal>
        </BaseToast.Provider>
    );
}

function NotificationList({ position }: { position: NotificationPosition }) {
    const { toasts } = BaseToast.useToastManager();

    return toasts.map((notification) => {
        const statusIcon = statusIconFor(notification.type);
        const hasTitle = hasRenderableText(notification.title);
        const accessibleName = hasTitle ? undefined : "Notification";

        return (
            <BaseToast.Root
                key={notification.id}
                toast={notification}
                data-slot="notification"
                data-position={position}
                swipeDirection={swipeDirectionsFor(position)}
                aria-label={accessibleName}
                className={styles.notification}
            >
                <BaseToast.Content
                    data-slot="notification-content"
                    className={cn(styles.content, statusIcon === null && styles.contentWithoutIcon)}
                >
                    {statusIcon}
                    <div className={styles.text}>
                        <BaseToast.Title className={styles.title} />
                        <BaseToast.Description className={styles.description} />
                        <BaseToast.Action type="button" className={styles.action} />
                    </div>
                    {/* Base UI hides this visible control when collapsed; the CSS keeps it accessible only for the front notification. */}
                    <BaseToast.Close
                        type="button"
                        aria-label="Dismiss notification"
                        aria-hidden={false}
                        data-slot="notification-close"
                        className={styles.close}
                    >
                        <Icon size="no-container">
                            <X />
                        </Icon>
                    </BaseToast.Close>
                </BaseToast.Content>
            </BaseToast.Root>
        );
    });
}

function hasRenderableText(value: ReactNode): boolean {
    return value !== undefined && value !== null && value !== "";
}

function statusIconFor(type: string | undefined) {
    switch (type) {
        case "info":
            return (
                <span className={styles.statusIcon} data-slot="notification-icon">
                    <Icon size="md">
                        <Info />
                    </Icon>
                </span>
            );
        case "success":
            return (
                <span className={styles.statusIcon} data-slot="notification-icon">
                    <Icon size="md">
                        <CircleCheck />
                    </Icon>
                </span>
            );
        case "warning":
            return (
                <span className={styles.statusIcon} data-slot="notification-icon">
                    <Icon size="md">
                        <TriangleAlert />
                    </Icon>
                </span>
            );
        case "error":
            return (
                <span className={styles.statusIcon} data-slot="notification-icon">
                    <Icon size="md">
                        <CircleAlert />
                    </Icon>
                </span>
            );
        default:
            return null;
    }
}

function swipeDirectionsFor(position: NotificationPosition): ("up" | "down" | "left" | "right")[] {
    const vertical: "up" | "down" = position.startsWith("top") ? "up" : "down";

    if (position.endsWith("left")) {
        return [vertical, "left"];
    }

    if (position.endsWith("right")) {
        return [vertical, "right"];
    }

    return [vertical];
}
