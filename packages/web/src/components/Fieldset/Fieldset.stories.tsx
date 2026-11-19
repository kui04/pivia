import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Field } from "../Field/Field";
import { Input } from "../Input/Input";

import { Fieldset } from "./Fieldset";

const fields = (
    <>
        <Field label="Company" name="company">
            <Input placeholder="Enter company name" />
        </Field>
        <Field label="Tax ID" name="tax-id">
            <Input placeholder="Enter fiscal number" />
        </Field>
    </>
);

const meta = {
    title: "Components/Fieldset",
    component: Fieldset,
    args: {
        legend: "Billing details",
        children: fields,
    },
    argTypes: {
        children: { control: false },
        legend: { control: "text" },
    },
} satisfies Meta<typeof Fieldset>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const group = canvas.getByRole("group", { name: "Billing details" });
        const company = within(group).getByLabelText("Company");

        await userEvent.type(company, "Atlas");

        await expect(company).toHaveValue("Atlas");
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByLabelText("Company")).toBeDisabled();
        await expect(canvas.getByLabelText("Tax ID")).toBeDisabled();
    },
};
