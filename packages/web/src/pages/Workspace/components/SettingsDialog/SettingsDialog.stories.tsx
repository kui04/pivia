import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, within } from "storybook/test";

import { Button } from "@components";

import { SettingsDialog, type SettingsDialogProps } from "./SettingsDialog";

const updatedAtMs = Date.parse("2026-01-03T12:00:00.000Z");

function SettingsDemo(props: Omit<SettingsDialogProps, "open" | "onOpenChange">) {
    const [open, setOpen] = useState(true);

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                onClick={() => {
                    setOpen(true);
                }}
            >
                Open settings
            </Button>
            <SettingsDialog {...props} open={open} onOpenChange={setOpen} />
        </>
    );
}

const onSignOut = fn();

const meta = {
    title: "Pages/Workspace/SettingsDialog",
    component: SettingsDialog,
    args: {
        open: true,
        onOpenChange: () => undefined,
        origin: "https://pivia.local:3141",
        sessionCount: 12,
        updatedAtMs,
        sync: { kind: "live" },
        onRefresh: fn(),
        authAction: { kind: "sign-out", pending: false, onSignOut },
    },
    argTypes: {
        open: { control: false },
        onOpenChange: { control: false },
        sync: { control: false },
        onRefresh: { control: false },
        authAction: { control: false },
    },
    render: (args) => (
        <SettingsDemo
            origin={args.origin}
            sessionCount={args.sessionCount}
            updatedAtMs={args.updatedAtMs}
            sync={args.sync}
            onRefresh={args.onRefresh}
            authAction={args.authAction}
        />
    ),
} satisfies Meta<typeof SettingsDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Authenticated: Story = {
    play: async ({ userEvent, args }) => {
        args.onRefresh.mockClear();
        onSignOut.mockClear();

        const dialog = await within(document.body).findByRole("dialog", { name: "Workspace settings" });
        await expect(within(dialog).getByText("https://pivia.local:3141")).toBeVisible();
        await expect(within(dialog).getByText("Connected")).toBeVisible();
        await expect(within(dialog).getByText("12")).toBeVisible();

        await userEvent.click(within(dialog).getByRole("button", { name: "Refresh now" }));
        await expect(args.onRefresh).toHaveBeenCalledTimes(1);

        await userEvent.click(within(dialog).getByRole("button", { name: "Sign out" }));
        await expect(onSignOut).toHaveBeenCalledTimes(1);
    },
};

export const NoAuth: Story = {
    args: {
        updatedAtMs: null,
        sync: { kind: "reconnecting", attempt: 3 },
        authAction: { kind: "none" },
    },
    play: async () => {
        const dialog = await within(document.body).findByRole("dialog", { name: "Workspace settings" });
        await expect(within(dialog).getByText("Reconnecting (attempt 3)…")).toBeVisible();
        await expect(within(dialog).getByText("Never")).toBeVisible();
        await expect(within(dialog).queryByRole("button", { name: /Sign out/ })).not.toBeInTheDocument();
    },
};
