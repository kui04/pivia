import { createToastManager } from "@/components/Toast/useToast";

/**
 * The one toast manager of the app.
 *
 * It lives outside React so a hook, a store callback or a component reports to
 * the same stack. `main.tsx` gives it to the single `ToastProvider`.
 */
export const toastManager = createToastManager();

/** One message to show in the app toast stack. */
export type AppToast = {
    /** A stable identifier. A later toast with the same id replaces the earlier one. */
    id: string;
    /** The short line the toast announces. */
    title: string;
    /** The detail under the title. */
    description?: string | undefined;
    /** An action that stays visible until the toast is dismissed. */
    action?: { label: string; onClick: () => void } | undefined;
};

/** Shows one error in the app toast stack. */
export function showError(toast: AppToast): void {
    addToast("error", toast);
}

/** Shows one warning in the app toast stack. */
export function showWarning(toast: AppToast): void {
    addToast("warning", toast);
}

/**
 * Adds one typed toast.
 *
 * An error is announced urgently; a warning is announced politely. Neither
 * times out, so a remediation such as "Forget saved key" stays until the user
 * dismisses it, and an action never disappears before the user reaches it.
 */
function addToast(type: "error" | "warning", toast: AppToast): void {
    toastManager.add({
        id: toast.id,
        type,
        priority: type === "error" ? "high" : "low",
        title: toast.title,
        description: toast.description,
        actionProps:
            toast.action === undefined
                ? undefined
                : {
                      children: toast.action.label,
                      onClick: toast.action.onClick,
                  },
    });
}
