import { useState, type ReactElement } from "react";

import {
    Button,
    Dialog,
    DialogActions,
    DialogClose,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    Field,
    Form,
    Input,
} from "@components";

export interface RenameSessionDialogProps {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly initialName: string;
    readonly pending?: boolean | undefined;
    readonly error?: string | null | undefined;
    readonly onSubmit: (name: string) => Promise<void> | void;
}

function RenameSessionBody({
    initialName,
    pending,
    error,
    onSubmit,
}: {
    readonly initialName: string;
    readonly pending: boolean;
    readonly error: string | null;
    readonly onSubmit: (name: string) => Promise<void> | void;
}): ReactElement {
    const [name, setName] = useState(initialName);
    const [validationError, setValidationError] = useState<string | null>(null);

    return (
        <Form
            onFormSubmit={() => {
                const trimmed = name.trim();
                if (trimmed.length === 0) {
                    setValidationError("Session name cannot be empty.");
                    return;
                }
                setValidationError(null);
                void onSubmit(trimmed);
            }}
        >
            <Field name="sessionName" label="Session name" error={validationError ?? error ?? undefined}>
                <Input
                    value={name}
                    disabled={pending}
                    placeholder="Session name"
                    onChange={(event) => {
                        setName(event.target.value);
                        if (validationError !== null) {
                            setValidationError(null);
                        }
                    }}
                />
            </Field>
            <DialogActions>
                <DialogClose render={<Button type="button" variant="secondary" disabled={pending} />}>
                    Cancel
                </DialogClose>
                <Button type="submit" disabled={pending}>
                    {pending ? "Saving..." : "Save"}
                </Button>
            </DialogActions>
        </Form>
    );
}

/**
 * Modal dialog for updating the active session's display name through `set_session_name`.
 */
export function RenameSessionDialog({
    open,
    onOpenChange,
    initialName,
    pending = false,
    error = null,
    onSubmit,
}: RenameSessionDialogProps): ReactElement {
    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (pending && !nextOpen) {
                    return;
                }
                onOpenChange(nextOpen);
            }}
        >
            <DialogHeader>
                <DialogTitle>Rename session</DialogTitle>
                <DialogDescription>Set the display title shown in the sidebar and top bar.</DialogDescription>
            </DialogHeader>
            {open ? (
                <RenameSessionBody initialName={initialName} pending={pending} error={error} onSubmit={onSubmit} />
            ) : null}
        </Dialog>
    );
}
