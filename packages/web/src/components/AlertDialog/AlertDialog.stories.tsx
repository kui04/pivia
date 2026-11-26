import type { Meta, StoryObj } from "@storybook/react-vite";
import { Trash, Upload } from "lucide-react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { DarkTheme, LightTheme } from "@/storybook/theme";

import { IconButton } from "../IconButton";

import { AlertDialog } from "./AlertDialog";

const onConfirm = fn();

const publishTrigger = (
    <IconButton label="Publish changes">
        <Upload />
    </IconButton>
);

const deleteTrigger = (
    <IconButton label="Delete file">
        <Trash />
    </IconButton>
);

const meta = {
    title: "Components/AlertDialog",
    component: AlertDialog,
    args: {
        trigger: publishTrigger,
        title: "Publish changes?",
        description: "The current draft will become visible to everyone.",
        confirmLabel: "Publish",
        onConfirm,
    },
    argTypes: {
        trigger: { control: false },
        title: { control: "text" },
        description: { control: "text" },
        cancelLabel: { control: "text" },
        confirmLabel: { control: "text" },
        onConfirm: { control: false },
    },
} satisfies Meta<typeof AlertDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

async function openFromTrigger(canvasElement: HTMLElement, name: string, dialogName: string) {
    const trigger = within(canvasElement).getByRole("button", { name });

    await userEvent.click(trigger);

    const dialog = await screen.findByRole("alertdialog", { name: dialogName });

    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));

    return { trigger, dialog };
}

export const Default: Story = {
    decorators: [LightTheme],
    play: async ({ canvasElement }) => {
        const { trigger, dialog } = await openFromTrigger(canvasElement, "Publish changes", "Publish changes?");
        const cancel = within(dialog).getByRole("button", { name: "Cancel" });

        await expect(within(dialog).getByText("The current draft will become visible to everyone.")).toBeVisible();
        await waitFor(() => expect(cancel).toHaveFocus());
        await expect(dialog).toHaveAttribute("aria-modal", "true");

        const backdrop = document.querySelector<HTMLElement>("[data-slot='alert-dialog-backdrop']");
        if (backdrop === null) {
            throw new Error("The alert dialog did not render a backdrop");
        }

        // Alert Dialog disables pointer dismissal; the backdrop is not an action.
        await userEvent.click(backdrop, { pointerEventsCheck: 0 });
        await expect(screen.getByRole("alertdialog", { name: "Publish changes?" })).toBeInTheDocument();

        await userEvent.click(cancel);
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Destructive: Story = {
    decorators: [LightTheme],
    args: {
        trigger: deleteTrigger,
        title: "Delete this file?",
        description: "The file will be removed permanently. This action cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
    },
    play: async ({ canvasElement }) => {
        onConfirm.mockClear();

        const { trigger, dialog } = await openFromTrigger(canvasElement, "Delete file", "Delete this file?");
        const confirm = within(dialog).getByRole("button", { name: "Delete" });

        await expect(confirm).toHaveAttribute("data-variant", "destructive");

        await userEvent.click(confirm);

        await expect(onConfirm).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Disabled: Story = {
    args: {
        confirmDisabled: true,
        confirmLabel: "Publish",
    },
    play: async ({ canvasElement }) => {
        const { dialog } = await openFromTrigger(canvasElement, "Publish changes", "Publish changes?");
        const confirm = within(dialog).getByRole("button", { name: "Publish" });

        await expect(confirm).toBeDisabled();
        await userEvent.click(confirm);
        await expect(screen.getByRole("alertdialog", { name: "Publish changes?" })).toBeInTheDocument();
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));

        const { dialog } = await openFromTrigger(canvasElement, "Publish changes", "Publish changes?");

        await expect(dialog).toBeVisible();
    },
};
