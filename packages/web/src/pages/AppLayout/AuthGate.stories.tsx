import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { AuthGate } from "./AuthGate";

const onSubmit = fn();

const meta = {
    title: "Pages/AuthGate",
    component: AuthGate,
    args: {
        error: null,
        submitting: false,
        onSubmit,
    },
    argTypes: {
        error: { control: "text" },
        submitting: { control: "boolean" },
        onSubmit: { control: false },
    },
} satisfies Meta<typeof AuthGate>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        onSubmit.mockClear();
        const canvas = within(canvasElement);
        const password = canvas.getByLabelText("Password");

        await userEvent.type(password, "hunter2");
        await userEvent.click(canvas.getByRole("button", { name: "Sign in" }));

        await expect(onSubmit).toHaveBeenCalledWith("hunter2");
    },
};

export const Submitting: Story = {
    args: {
        submitting: true,
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const submit = canvas.getByRole("button", { name: "Signing in..." });

        await expect(submit).toBeDisabled();
        await expect(canvas.getByLabelText("Password")).toBeVisible();
    },
};

export const InvalidPassword: Story = {
    args: {
        error: "Invalid password.",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const password = canvas.getByLabelText("Password");

        await expect(canvas.getByRole("alert")).toHaveTextContent("Invalid password.");
        await expect(password).toHaveAttribute("aria-invalid", "true");
    },
};

export const RateLimited: Story = {
    args: {
        error: "Too many attempts. Try again in 30 seconds.",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("alert")).toHaveTextContent("Try again in 30 seconds.");
        await expect(canvas.getByRole("button", { name: "Sign in" })).toBeEnabled();
    },
};
