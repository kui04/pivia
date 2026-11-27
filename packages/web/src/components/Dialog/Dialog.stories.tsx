import type { Meta, StoryObj } from "@storybook/react-vite";
import { Plus } from "lucide-react";
import { useState } from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";

import { DarkTheme } from "@/storybook/theme";

import { Field } from "../Field";
import { Form } from "../Form";
import { IconButton } from "../IconButton";
import { Input } from "../Input";
import { Select } from "../Select";

import { requireElement, waitForDarkTheme } from "@/storybook/dom";
import { Button } from "@components/Button";

import { Dialog, DialogActions, DialogClose, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";

const onSubmit = fn();

const visibilityOptions = [
    { value: "private", label: "Private" },
    { value: "team", label: "Team" },
    { value: "public", label: "Public" },
] as const;

function DialogDemo() {
    const [open, setOpen] = useState(false);

    return (
        <Dialog
            open={open}
            onOpenChange={setOpen}
            trigger={
                <IconButton label="New project">
                    <Plus />
                </IconButton>
            }
        >
            <DialogHeader>
                <DialogTitle>Create project</DialogTitle>
                <DialogDescription>Set up a project for the current workspace.</DialogDescription>
            </DialogHeader>
            <Form
                onFormSubmit={(values) => {
                    onSubmit(values);
                    setOpen(false);
                }}
            >
                <Field label="Name" name="name">
                    <Input placeholder="e.g. Atlas" autoComplete="off" required />
                </Field>
                <Field
                    label="Visibility"
                    name="visibility"
                    nativeLabel={false}
                    description="Private projects stay on this device."
                >
                    <Select defaultValue="private" options={visibilityOptions} />
                </Field>
                <Field label="Description" name="description">
                    <Input placeholder="Optional" />
                </Field>
                <DialogActions>
                    <DialogClose render={<Button type="button" variant="secondary" />}>Cancel</DialogClose>
                    <Button type="submit">Create</Button>
                </DialogActions>
            </Form>
        </Dialog>
    );
}

const meta = {
    title: "Components/Dialog",
    component: Dialog,
    args: {
        children: null,
    },
} satisfies Meta<typeof Dialog>;

export default meta;

type Story = StoryObj<typeof meta>;

async function openDialog(canvasElement: HTMLElement) {
    const trigger = within(canvasElement).getByRole("button", { name: "New project" });

    await userEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Create project" });

    await waitFor(() => expect(getComputedStyle(dialog).opacity).toBe("1"));

    return { trigger, dialog };
}

export const Default: Story = {
    render: () => <DialogDemo />,
    play: async ({ canvasElement }) => {
        onSubmit.mockClear();

        const { trigger, dialog } = await openDialog(canvasElement);
        const name = within(dialog).getByLabelText("Name");
        const visibility = within(dialog).getByRole("combobox", { name: "Visibility" });

        await waitFor(() => expect(name).toHaveFocus());
        await expect(dialog).toHaveAttribute("aria-modal", "true");

        await userEvent.type(name, "Atlas");
        await userEvent.click(visibility);

        const listbox = await screen.findByRole("listbox", { name: "Visibility" });
        const popup = requireElement(
            document.querySelector<HTMLElement>("[data-slot='select-popup']"),
            "the select popup",
        );

        await waitFor(() => expect(getComputedStyle(popup).opacity).toBe("1"));
        await userEvent.click(within(listbox).getByRole("option", { name: "Team" }));
        await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument(), { timeout: 3000 });
        await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

        await expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "Atlas", visibility: "team" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(trigger).toHaveFocus());
    },
};

export const Validation: Story = {
    render: () => <DialogDemo />,
    play: async ({ canvasElement }) => {
        onSubmit.mockClear();

        const { dialog } = await openDialog(canvasElement);
        const name = within(dialog).getByLabelText("Name");

        await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));

        await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
        await expect(name).toHaveAttribute("aria-invalid", "true");
        await expect(onSubmit).not.toHaveBeenCalled();
        await expect(screen.getByRole("dialog", { name: "Create project" })).toBeInTheDocument();
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    render: () => <DialogDemo />,
    play: async ({ canvasElement }) => {
        await waitForDarkTheme();

        const { dialog } = await openDialog(canvasElement);

        await expect(getComputedStyle(dialog).backgroundColor).toBe("rgb(32, 32, 32)");
        await expect(within(dialog).getByLabelText("Name")).toBeInTheDocument();
    },
};
