import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { Field } from "../Field/Field";

import { Input } from "./Input";

const primaryColors = ["rgb(0, 95, 184)", "rgb(0, 120, 212)"];
const errorColors = ["rgb(199, 46, 15)", "rgb(248, 81, 73)"];

const meta = {
    title: "Components/Input",
    component: Input,
    args: {
        placeholder: "e.g. Atlas",
    },
    argTypes: {
        placeholder: { control: "text" },
        type: { control: "text" },
    },
} satisfies Meta<typeof Input>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => (
        <Field label="Project name" description="This name is shown in the workspace." name="project-name">
            <Input {...args} />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByLabelText("Project name");

        await userEvent.tab();
        await userEvent.type(input, "Atlas");

        await expect(input).toHaveValue("Atlas");
        await expect(input).toHaveFocus();
        await expect(canvas.getByText("This name is shown in the workspace.")).toBeVisible();

        // The hover rule must not replace the focus border. A synthetic Tab inside the Storybook
        // iframe does not always set :focus-visible in a real browser, so only assert this
        // interaction when the browser reports the keyboard focus state.
        if (input.matches(":focus-visible")) {
            await userEvent.hover(input);
            await waitFor(() => expect(primaryColors).toContain(getComputedStyle(input).borderColor));
        }
    },
};

export const WithError: Story = {
    args: {
        defaultValue: "Atlas",
    },
    render: (args) => (
        <Field
            label="Project name"
            description="Use a name that is unique in this workspace."
            error="A project with this name already exists."
            name="project-name"
        >
            <Input {...args} />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const input = canvas.getByLabelText("Project name");

        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(canvas.getByRole("alert")).toHaveTextContent("A project with this name already exists.");
        await expect(canvas.getByText("Use a name that is unique in this workspace.")).not.toBeVisible();

        // Hovering an invalid field must keep the error border.
        await userEvent.hover(input);
        await waitFor(() => expect(errorColors).toContain(getComputedStyle(input).borderColor));
        await expect(errorColors.some((color) => getComputedStyle(input).boxShadow.includes(color))).toBe(true);
    },
};
