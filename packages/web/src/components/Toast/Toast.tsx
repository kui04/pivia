import { Toast as BaseToast } from "@base-ui/react/toast";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib";

import { Icon } from "../Icon";
import styles from "./Toast.module.css";

type BaseProviderProps = ComponentProps<typeof BaseToast.Provider>;

export type ToastPosition = "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export type ToastProviderProps = BaseProviderProps & {
    /** Accessible name for the live region. Defaults to "Toasts". */
    label?: string | undefined;
    /** Where the stack sits in the viewport. Defaults to "bottom-right". */
    position?: ToastPosition;
    /** Class on the fixed viewport, which is portaled outside the app tree. */
    viewportClassName?: string | undefined;
};

/**
 * Wraps Base UI Toast and renders the single fixed viewport for the app.
 * Children call `useToast()` to add messages. Base UI owns timers, the
 * stack limit, keyboard navigation, swipe dismissal and the live-region
 * semantics.
 */
export function ToastProvider({
    children,
    label = "Toasts",
    position = "bottom-right",
    viewportClassName,
    ...props
}: ToastProviderProps) {
    return (
        <BaseToast.Provider {...props}>
            {children}
            <BaseToast.Portal>
                <BaseToast.Viewport
                    data-slot="toast-viewport"
                    data-position={position}
                    aria-label={label}
                    className={cn(styles.viewport, viewportClassName)}
                >
                    <ToastList position={position} />
                </BaseToast.Viewport>
            </BaseToast.Portal>
        </BaseToast.Provider>
    );
}

function ToastList({ position }: { position: ToastPosition }) {
    const { toasts } = BaseToast.useToastManager();

    return toasts.map((toast) => {
        const statusIcon = statusIconFor(toast.type);
        const hasTitle = hasRenderableText(toast.title);
        const accessibleName = hasTitle ? undefined : "Toast";

        return (
            <BaseToast.Root
                key={toast.id}
                toast={toast}
                data-slot="toast"
                data-position={position}
                swipeDirection={swipeDirectionsFor(position)}
                aria-label={accessibleName}
                className={styles.toast}
            >
                <BaseToast.Content
                    data-slot="toast-content"
                    className={cn(styles.content, statusIcon === null && styles.contentWithoutIcon)}
                >
                    {statusIcon}
                    <div className={styles.text}>
                        <BaseToast.Title className={styles.title} />
                        <BaseToast.Description className={styles.description} />
                        <BaseToast.Action type="button" className={styles.action} />
                    </div>
                    {/* Base UI hides this visible control when collapsed; the CSS keeps it accessible only for the front toast. */}
                    <BaseToast.Close
                        type="button"
                        aria-label="Dismiss toast"
                        aria-hidden={false}
                        data-slot="toast-close"
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
                <span className={styles.statusIcon} data-slot="toast-icon">
                    <Icon size="md">
                        <Info />
                    </Icon>
                </span>
            );
        case "success":
            return (
                <span className={styles.statusIcon} data-slot="toast-icon">
                    <Icon size="md">
                        <CircleCheck />
                    </Icon>
                </span>
            );
        case "warning":
            return (
                <span className={styles.statusIcon} data-slot="toast-icon">
                    <Icon size="md">
                        <TriangleAlert />
                    </Icon>
                </span>
            );
        case "error":
            return (
                <span className={styles.statusIcon} data-slot="toast-icon">
                    <Icon size="md">
                        <CircleAlert />
                    </Icon>
                </span>
            );
        default:
            return null;
    }
}

function swipeDirectionsFor(position: ToastPosition): ("up" | "down" | "left" | "right")[] {
    const vertical: "up" | "down" = position.startsWith("top") ? "up" : "down";

    if (position.endsWith("left")) {
        return [vertical, "left"];
    }

    if (position.endsWith("right")) {
        return [vertical, "right"];
    }

    return [vertical];
}
