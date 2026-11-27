import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";

import { requireElement } from "@/storybook/dom";
import { Checkbox } from "./Checkbox";

const onCheckedChange = fn();

function ControlledCheckbox() {
    const [checked, setChecked] = useState(false);

    return (
        <Checkbox
            label="Remember this key"
            description="The server fingerprint is kept for the next connection."
            checked={checked}
            onCheckedChange={setChecked}
        />
    );
}

const meta = {
    title: "Components/Checkbox",
    component: Checkbox,
    args: {
        label: "Remember this key",
        checked: false,
        onCheckedChange,
    },
    argTypes: {
        description: { control: "text" },
        disabled: { control: "boolean" },
        onCheckedChange: { control: false },
    },
} satisfies Meta<typeof Checkbox>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const box = canvas.getByRole("checkbox", { name: "Remember this key" });

        await expect(box).toBeInTheDocument();
        // Browser zoom and non-integer DPRs return fractional layout pixels; compare snapped values.
        await expect(Math.round(box.getBoundingClientRect().width)).toBe(16);

        // Base UI focuses the visible span; the document rule must draw its ring.
        await userEvent.tab();
        await expect(box).toHaveFocus();

        // A synthetic Tab inside the Storybook iframe does not always set :focus-visible in a
        // real browser. The CLI run still exercises the ring; only assert it when the browser
        // reports the keyboard focus state.
        if (box.matches(":focus-visible")) {
            await expect(getComputedStyle(box).outlineStyle).toBe("solid");
            await expect(Math.round(Number.parseFloat(getComputedStyle(box).outlineOffset))).toBe(2);
        }
    },
};

export const WithDescription: Story = {
    args: {
        description: "Saved in this app's storage in plain text. Leave it off on a shared device.",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const box = canvas.getByRole("checkbox", {
            name: "Remember this key",
            description: "Saved in this app's storage in plain text. Leave it off on a shared device.",
        });

        await expect(box).toBeInTheDocument();
    },
};

export const EmptyDescription: Story = {
    args: {
        description: "",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const box = canvas.getByRole("checkbox", { name: "Remember this key" });

        await expect(box).not.toHaveAttribute("aria-describedby");
        await expect(canvasElement.querySelector("p")).toBeNull();
    },
};

export const Disabled: Story = {
    args: {
        disabled: true,
        checked: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const box = canvas.getByRole("checkbox", { name: "Remember this key" });
        const input = requireElement(
            canvasElement.querySelector<HTMLInputElement>('input[type="checkbox"]'),
            "the hidden input",
        );
        const check = requireElement(canvasElement.querySelector('[data-slot="checkbox"] svg'), "the check");

        await expect(box).toHaveAttribute("aria-disabled", "true");
        await expect(box).toHaveAttribute("tabindex", "-1");
        await expect(Math.round(box.getBoundingClientRect().width)).toBe(16);

        await expect(input).toBeDisabled();

        await expect(Math.round(check.getBoundingClientRect().width)).toBe(12);
    },
};

export const Controlled: Story = {
    render: () => <ControlledCheckbox />,
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const box = canvas.getByRole("checkbox", { name: "Remember this key" });

        await expect(box).not.toBeChecked();
        await userEvent.click(canvas.getByText("Remember this key"));
        await expect(box).toBeChecked();
        await userEvent.click(box);
        await expect(box).not.toBeChecked();
    },
};
