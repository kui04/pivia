import { createNotificationManager } from "@/components/Notification/useNotification";

/**
 * The one notification manager of the app.
 *
 * It lives outside React so a hook, a store callback or a component reports to
 * the same stack. `main.tsx` gives it to the single `NotificationProvider`.
 */
export const notificationManager = createNotificationManager();

/** One message to show in the app notification stack. */
export type AppNotification = {
    /** A stable identifier. A later notification with the same id replaces the earlier one. */
    id: string;
    /** The short line the notification announces. */
    title: string;
    /** The detail under the title. */
    description?: string | undefined;
    /** An action that stays visible until the notification is dismissed. */
    action?: { label: string; onClick: () => void } | undefined;
};

/** Shows one error in the app notification stack. */
export function showError(notification: AppNotification): void {
    addNotification("error", notification);
}

/** Shows one warning in the app notification stack. */
export function showWarning(notification: AppNotification): void {
    addNotification("warning", notification);
}

/**
 * Adds one typed notification.
 *
 * An error is announced urgently; a warning is announced politely. Neither
 * times out, so a remediation such as "Forget saved key" stays until the user
 * dismisses it, and an action never disappears before the user reaches it.
 */
function addNotification(type: "error" | "warning", notification: AppNotification): void {
    notificationManager.add({
        id: notification.id,
        type,
        priority: type === "error" ? "high" : "low",
        title: notification.title,
        description: notification.description,
        actionProps:
            notification.action === undefined
                ? undefined
                : {
                      children: notification.action.label,
                      onClick: notification.action.onClick,
                  },
    });
}
