import type { Meta, StoryObj } from "@storybook/react-vite";
import { Trash, Upload } from "lucide-react";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { IconButton } from "../IconButton/IconButton";

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

function LightTheme({ children }: { children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = "light";

        return () => {
            delete root.dataset.theme;
        };
    }, []);

    return <>{children}</>;
}

function DarkTheme({ children }: { children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = "dark";

        return () => {
            delete root.dataset.theme;
        };
    }, []);

    return <>{children}</>;
}

async function openFromTrigger(canvasElement: HTMLElement, name: string, dialogName: string) {
    const trigger = within(canvasElement).getByRole("button", { name });

    await userEvent.click(trigger);

    const dialog = await screen.findByRole("alertdialog", { name: dialogName });

    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));

    return { trigger, dialog };
}

export const Default: Story = {
    decorators: [
        (Story) => (
            <LightTheme>
                <Story />
            </LightTheme>
        ),
    ],
    play: async ({ canvasElement }) => {
        const { trigger, dialog } = await openFromTrigger(canvasElement, "Publish changes", "Publish changes?");
        const cancel = within(dialog).getByRole("button", { name: "Cancel" });

        await expect(within(dialog).getByText("The current draft will become visible to everyone.")).toBeVisible();
        await waitFor(() => expect(cancel).toHaveFocus());

        await expect(getComputedStyle(cancel).borderColor).toBe("rgb(140, 140, 140)");
        await expect(dialog).toHaveAttribute("aria-modal", "true");

        const style = getComputedStyle(dialog);
        await expect(Math.round(Number.parseFloat(style.borderRadius))).toBe(28);
        await expect(style.backgroundColor).toBe("rgb(255, 255, 255)");
        await expect(style.boxShadow).not.toBe("none");
        await expect(style.transitionProperty).toContain("opacity");
        await expect(style.transitionProperty).toContain("scale");
        await expect(style.transitionDuration).toContain("0.2s");

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
    decorators: [
        (Story) => (
            <LightTheme>
                <Story />
            </LightTheme>
        ),
    ],
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

        // The error roles drive the confirming action.
        await expect(getComputedStyle(confirm).backgroundColor).toBe("rgb(199, 46, 15)");

        await userEvent.click(confirm);

        await expect(onConfirm).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Keyboard: Story = {
    play: async ({ canvasElement }) => {
        const trigger = within(canvasElement).getByRole("button", { name: "Publish changes" });

        trigger.focus();
        await userEvent.keyboard("{Enter}");

        const dialog = await screen.findByRole("alertdialog", { name: "Publish changes?" });
        const cancel = within(dialog).getByRole("button", { name: "Cancel" });

        await waitFor(() => expect(cancel).toHaveFocus());

        await userEvent.keyboard("{Escape}");

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
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));

        const { dialog } = await openFromTrigger(canvasElement, "Publish changes", "Publish changes?");

        await expect(getComputedStyle(dialog).backgroundColor).toBe("rgb(32, 32, 32)");

        const backdrop = document.querySelector<HTMLElement>("[data-slot='alert-dialog-backdrop']");
        if (backdrop === null) {
            throw new Error("The alert dialog did not render a backdrop");
        }

        await expect(getComputedStyle(backdrop).backgroundColor).toBe("rgba(0, 0, 0, 0.45)");
    },
};
