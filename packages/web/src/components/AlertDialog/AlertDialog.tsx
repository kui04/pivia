import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import type { ComponentProps, MouseEventHandler, ReactElement, ReactNode } from "react";

import { cn } from "@/lib";

import surface from "../Dialog/DialogSurface.module.css";
import styles from "./AlertDialog.module.css";

type RootProps = Omit<ComponentProps<typeof BaseAlertDialog.Root>, "children" | "handle">;

export type AlertDialogProps = RootProps & {
    /**
     * Element that opens the dialog. Omit it for a fully controlled dialog.
     * When provided, it must forward DOM props and its ref to a native button.
     */
    trigger?: ReactElement | undefined;
    /** Heading that labels the dialog. */
    title: ReactNode;
    /** Supporting text that explains the consequence. */
    description?: ReactNode;
    /** Additional content between the description and the actions. */
    children?: ReactNode;
    /** Text of the dismissive action. */
    cancelLabel?: string;
    /** Text of the confirming action. */
    confirmLabel?: string;
    /** Uses the error role for the confirming action. */
    destructive?: boolean;
    /** Prevents the confirming action without changing the rest of the dialog. */
    confirmDisabled?: boolean;
    /** Runs when the confirming action is pressed. The dialog closes immediately after this handler. */
    onConfirm?: MouseEventHandler<HTMLButtonElement> | undefined;
    /** Styles the dialog popup. */
    className?: string | undefined;
};

/**
 * A modal alert dialog built on Base UI Alert Dialog. Base UI owns the modal
 * focus trap, scroll lock, Escape handling, focus return and the `alertdialog`
 * role; the backdrop and popup use the surface, scrim, shape, type and motion
 * tokens. The caller supplies the trigger and chooses whether the confirming
 * action is destructive.
 *
 * The dialog closes on either action. For an asynchronous confirmation, control
 * `open` and stop the close in `onOpenChange` until the work finishes.
 */
export function AlertDialog({
    trigger,
    title,
    description,
    children,
    cancelLabel = "Cancel",
    confirmLabel = "Confirm",
    destructive = false,
    confirmDisabled = false,
    onConfirm,
    className,
    ...props
}: AlertDialogProps) {
    return (
        <BaseAlertDialog.Root {...props}>
            {trigger === undefined ? null : <BaseAlertDialog.Trigger render={trigger} />}
            <BaseAlertDialog.Portal>
                <BaseAlertDialog.Backdrop data-slot="alert-dialog-backdrop" className={surface.backdrop} />
                <BaseAlertDialog.Viewport data-slot="alert-dialog-viewport" className={surface.viewport}>
                    <BaseAlertDialog.Popup
                        data-slot="alert-dialog"
                        aria-modal="true"
                        className={cn(surface.popup, styles.popup, className)}
                    >
                        <div className={surface.header}>
                            <BaseAlertDialog.Title data-slot="alert-dialog-title" className={surface.title}>
                                {title}
                            </BaseAlertDialog.Title>
                            {description === undefined || description === null ? null : (
                                <BaseAlertDialog.Description
                                    data-slot="alert-dialog-description"
                                    className={surface.description}
                                >
                                    {description}
                                </BaseAlertDialog.Description>
                            )}
                        </div>
                        {children === undefined || children === null ? null : (
                            <div className={styles.body}>{children}</div>
                        )}
                        <div className={cn(surface.actions, styles.actions)} data-slot="alert-dialog-actions">
                            <BaseAlertDialog.Close
                                type="button"
                                data-slot="alert-dialog-cancel"
                                className={cn(styles.action, styles.cancel)}
                            >
                                {cancelLabel}
                            </BaseAlertDialog.Close>
                            <BaseAlertDialog.Close
                                type="button"
                                data-slot="alert-dialog-confirm"
                                data-variant={destructive ? "destructive" : "primary"}
                                className={cn(styles.action, styles.confirm, destructive && styles.destructive)}
                                disabled={confirmDisabled}
                                onClick={onConfirm}
                            >
                                {confirmLabel}
                            </BaseAlertDialog.Close>
                        </div>
                    </BaseAlertDialog.Popup>
                </BaseAlertDialog.Viewport>
            </BaseAlertDialog.Portal>
        </BaseAlertDialog.Root>
    );
}
