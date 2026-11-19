import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps, ReactElement, ReactNode } from "react";

import { cn } from "../../lib/cn";

import styles from "./DialogSurface.module.css";

type RootProps = Omit<ComponentProps<typeof BaseDialog.Root>, "children">;

export type DialogProps = RootProps & {
    /** Element that opens the dialog. Omit it for a fully controlled dialog. */
    trigger?: ReactElement | undefined;
    /** Dialog content, composed from the exported title, description and action parts. */
    children: ReactNode;
    /** Initial focus target. Base UI defaults to the first tabbable field. */
    initialFocus?: ComponentProps<typeof BaseDialog.Popup>["initialFocus"];
    /** Styles the dialog popup. */
    className?: string | undefined;
};

/**
 * The base dialog shell built on Base UI Dialog. It renders the backdrop,
 * centered viewport and popup with the shared layout and surface styles, but
 * owns no title, body or action buttons. Compose those from DialogHeader,
 * DialogTitle, DialogDescription, DialogActions and DialogClose, or put a Form
 * inside the popup. Base UI owns focus trapping, scroll lock, Escape and focus
 * return.
 */
export function Dialog({ trigger, children, initialFocus, className, modal, ...props }: DialogProps) {
    const isModal = modal === undefined || modal === true;

    return (
        <BaseDialog.Root {...props} modal={modal}>
            {trigger === undefined ? null : <BaseDialog.Trigger render={trigger} />}
            <BaseDialog.Portal>
                <BaseDialog.Backdrop data-slot="dialog-backdrop" className={styles.backdrop} />
                <BaseDialog.Viewport data-slot="dialog-viewport" className={styles.viewport}>
                    <BaseDialog.Popup
                        data-slot="dialog"
                        aria-modal={isModal ? "true" : undefined}
                        initialFocus={initialFocus}
                        className={cn(styles.popup, className)}
                    >
                        {children}
                    </BaseDialog.Popup>
                </BaseDialog.Viewport>
            </BaseDialog.Portal>
        </BaseDialog.Root>
    );
}

type DialogHeaderProps = ComponentProps<"div">;

export function DialogHeader({ className, ...props }: DialogHeaderProps) {
    return <div {...props} data-slot="dialog-header" className={cn(styles.header, className)} />;
}

type DialogTitleProps = Omit<ComponentProps<typeof BaseDialog.Title>, "className"> & {
    className?: string | undefined;
};

export function DialogTitle({ className, ...props }: DialogTitleProps) {
    return <BaseDialog.Title {...props} data-slot="dialog-title" className={cn(styles.title, className)} />;
}

type DialogDescriptionProps = Omit<ComponentProps<typeof BaseDialog.Description>, "className"> & {
    className?: string | undefined;
};

export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
    return (
        <BaseDialog.Description
            {...props}
            data-slot="dialog-description"
            className={cn(styles.description, className)}
        />
    );
}

type DialogActionsProps = ComponentProps<"div">;

export function DialogActions({ className, ...props }: DialogActionsProps) {
    return <div {...props} data-slot="dialog-actions" className={cn(styles.actions, className)} />;
}

type DialogCloseProps = Omit<ComponentProps<typeof BaseDialog.Close>, "className"> & {
    className?: string | undefined;
};

export function DialogClose({ className, ...props }: DialogCloseProps) {
    return <BaseDialog.Close {...props} data-slot="dialog-close" className={className} />;
}
