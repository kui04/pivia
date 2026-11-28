import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState, type ReactElement } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { RadioGroup, RadioGroupItem } from "./RadioGroup";

const onValueChange = fn<(value: string) => void>();

function ControlledGroup(): ReactElement {
    const [value, setValue] = useState<string | null>(null);

    return (
        <RadioGroup
            ariaLabel="Branch"
            value={value}
            onValueChange={(next) => {
                setValue(next);
                onValueChange(next);
            }}
        >
            <RadioGroupItem value="main">main</RadioGroupItem>
            <RadioGroupItem value="dev">dev</RadioGroupItem>
            <RadioGroupItem value="release">release</RadioGroupItem>
        </RadioGroup>
    );
}

const meta = {
    title: "Components/RadioGroup",
    component: RadioGroup,
    args: { children: null },
} satisfies Meta<typeof RadioGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    render: () => (
        <RadioGroup ariaLabel="Branch">
            <RadioGroupItem value="main">main</RadioGroupItem>
            <RadioGroupItem value="dev">dev</RadioGroupItem>
            <RadioGroupItem value="release">release</RadioGroupItem>
        </RadioGroup>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const group = canvas.getByRole("radiogroup", { name: "Branch" });
        const main = canvas.getByRole("radio", { name: "main" });
        const dev = canvas.getByRole("radio", { name: "dev" });

        await expect(group).toBeInTheDocument();
        await expect(main).not.toBeChecked();

        await userEvent.click(dev);
        await expect(dev).toBeChecked();
        await expect(main).not.toBeChecked();

        dev.focus();
        await userEvent.keyboard("{ArrowDown}");
        await expect(canvas.getByRole("radio", { name: "release" })).toBeChecked();
    },
};

export const Controlled: Story = {
    render: () => <ControlledGroup />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const dev = canvas.getByRole("radio", { name: "dev" });

        await expect(dev).not.toBeChecked();
        await userEvent.click(dev);
        await expect(dev).toBeChecked();
        await expect(onValueChange).toHaveBeenLastCalledWith("dev");
    },
};

export const Disabled: Story = {
    render: () => (
        <RadioGroup ariaLabel="Branch" disabled>
            <RadioGroupItem value="main">main</RadioGroupItem>
            <RadioGroupItem value="dev">dev</RadioGroupItem>
        </RadioGroup>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const main = canvas.getByRole("radio", { name: "main" });

        await expect(main).toHaveAttribute("aria-disabled", "true");
        await userEvent.click(main);
        await expect(main).not.toBeChecked();
    },
};
