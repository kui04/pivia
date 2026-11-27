import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Input } from "../Input";

import { requireElement } from "@/storybook/dom";
import { Field } from "./Field";

const meta = {
    title: "Components/Field",
    component: Field,
    args: {
        label: "Project name",
        name: "project-name",
        description: "This name is shown in the workspace.",
        children: <Input placeholder="e.g. Atlas" />,
    },
    argTypes: {
        children: { control: false },
        label: { control: "text" },
        description: { control: "text" },
        error: { control: "text" },
    },
} satisfies Meta<typeof Field>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByLabelText("Project name");

        await userEvent.type(input, "Atlas");

        await expect(input).toHaveValue("Atlas");
        await expect(canvas.getByText("This name is shown in the workspace.")).toBeVisible();
    },
};

export const WithoutDescription: Story = {
    render: () => (
        <Field label="Project name" name="project-name">
            <Input placeholder="e.g. Atlas" />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const messages = requireElement(
            canvasElement.querySelector<HTMLElement>("[data-slot='field-messages']"),
            "messages",
        );

        await expect(getComputedStyle(messages).display).toBe("none");
        await expect(canvasElement.querySelector("[data-slot='field-description']")).toBeNull();
        await expect(canvasElement.querySelector("[data-slot='field-error']")).toBeNull();
    },
};

export const WithError: Story = {
    args: {
        error: "A project with this name already exists.",
        children: <Input defaultValue="Atlas" />,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByLabelText("Project name");

        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(canvas.getByRole("alert")).toHaveTextContent("A project with this name already exists.");
        await expect(canvas.getByText("This name is shown in the workspace.")).not.toBeVisible();
    },
};

export const InvalidWithoutMessage: Story = {
    args: {
        invalid: true,
        children: <Input defaultValue="Atlas" />,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByLabelText("Project name");

        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(canvas.getByText("This name is shown in the workspace.")).toBeVisible();
        await expect(canvas.queryByRole("alert")).toBeNull();
    },
};

function StableLayoutField() {
    const [error, setError] = useState<string | undefined>(undefined);

    return (
        <>
            <button
                type="button"
                onClick={() => {
                    setError((current) =>
                        current === undefined ? "A project with this name already exists." : undefined,
                    );
                }}
            >
                Toggle error
            </button>
            <Field label="Project name" description="This name is shown in the workspace." error={error}>
                <Input defaultValue="Atlas" />
            </Field>
        </>
    );
}

export const StableLayout: Story = {
    render: () => <StableLayoutField />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const field = requireElement(canvasElement.querySelector<HTMLElement>("[data-slot='field']"), "the field");

        const height = field.getBoundingClientRect().height;

        await userEvent.click(canvas.getByRole("button", { name: "Toggle error" }));

        await expect(await canvas.findByRole("alert")).toBeVisible();
        await expect(canvas.getByText("This name is shown in the workspace.")).not.toBeVisible();
        await expect(Math.round(field.getBoundingClientRect().height)).toBe(Math.round(height));

        await userEvent.click(canvas.getByRole("button", { name: "Toggle error" }));
        await waitFor(() => expect(canvas.queryByRole("alert")).not.toBeInTheDocument());
        await expect(Math.round(field.getBoundingClientRect().height)).toBe(Math.round(height));
    },
};
