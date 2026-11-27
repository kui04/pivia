import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, screen, userEvent, waitFor, within } from "storybook/test";

import { Field } from "../Field";

import { requireElement } from "@/storybook/dom";
import { Select } from "./Select";

const options = [
    { value: "private", label: "Private" },
    { value: "team", label: "Team" },
    { value: "public", label: "Public" },
];

const primaryColors = ["rgb(0, 95, 184)", "rgb(0, 120, 212)"];
const errorColors = ["rgb(199, 46, 15)", "rgb(248, 81, 73)"];

const meta = {
    title: "Components/Select",
    component: Select,
    args: {
        options,
        name: "visibility",
        placeholder: "Choose visibility",
    },
    argTypes: {
        options: { control: false },
        placeholder: { control: "text" },
    },
} satisfies Meta<typeof Select>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: (args) => (
        <Field
            label="Visibility"
            name="visibility"
            nativeLabel={false}
            description="This controls who can open the project."
        >
            <Select {...args} />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("combobox", { name: "Visibility" });

        await expect(trigger).toHaveTextContent("Choose visibility");
        await userEvent.click(trigger);

        const listbox = await screen.findByRole("listbox", { name: "Visibility" }, { timeout: 3000 });
        const popup = requireElement(
            document.querySelector<HTMLElement>("[data-slot='select-popup']"),
            "the select popup",
        );

        await waitFor(() => expect(Number.parseFloat(getComputedStyle(popup).opacity)).toBeGreaterThan(0.99));

        // Hover must not replace the open trigger's primary border.
        await userEvent.hover(trigger);
        await waitFor(() => expect(primaryColors).toContain(getComputedStyle(trigger).borderColor));
        await expect(primaryColors.some((color) => getComputedStyle(trigger).boxShadow.includes(color))).toBe(true);

        await userEvent.click(within(listbox).getByRole("option", { name: "Team" }));

        await expect(trigger).toHaveTextContent("Team");
        await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument(), { timeout: 3000 });
    },
};

export const WithError: Story = {
    render: (args) => (
        <Field
            label="Visibility"
            name="visibility"
            nativeLabel={false}
            description="This controls who can open the project."
            error="Choose a visibility before continuing."
        >
            <Select {...args} />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const trigger = canvas.getByRole("combobox", { name: "Visibility" });

        await expect(trigger).toHaveAttribute("aria-invalid", "true");
        await expect(canvas.getByRole("alert")).toHaveTextContent("Choose a visibility before continuing.");
        await expect(canvas.getByText("This controls who can open the project.")).not.toBeVisible();
        await waitFor(() => expect(errorColors).toContain(getComputedStyle(trigger).borderColor));
        await expect(errorColors.some((color) => getComputedStyle(trigger).boxShadow.includes(color))).toBe(true);
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    render: (args) => (
        <Field label="Visibility" name="visibility" nativeLabel={false}>
            <Select {...args} />
        </Field>
    ),
    play: async ({ canvasElement }) => {
        const trigger = within(canvasElement).getByRole("combobox", { name: "Visibility" });

        await expect(trigger).toBeDisabled();
    },
};
