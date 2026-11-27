import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { DarkTheme } from "@/storybook/theme";

import { requireElement, waitForDarkTheme } from "@/storybook/dom";
import { StoryRow } from "@/storybook/frames";

import { LoadingIndicator } from "./LoadingIndicator";

const meta = {
    title: "Components/LoadingIndicator",
    component: LoadingIndicator,
    args: {
        label: "Loading",
    },
    argTypes: {
        label: { control: "text" },
        size: { control: "select", options: ["sm", "no-container", "md", "lg", "xl"] },
    },
} satisfies Meta<typeof LoadingIndicator>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const indicator = canvas.getByRole("progressbar", { name: "Loading" });

        await expect(indicator).toHaveAttribute("data-slot", "loading-indicator");
        await expect(indicator).toHaveAttribute("data-size", "md");
        await expect(indicator).toHaveAttribute("data-indeterminate");
        await expect(indicator).not.toHaveAttribute("aria-valuenow");
        await expect(indicator).toHaveAttribute("aria-valuetext", "indeterminate progress");

        const svg = requireElement(indicator.querySelector("svg"), "the spinner svg");
        const spinner = requireElement(svg.querySelector("g"), "the spinning group");
        const track = requireElement(indicator.querySelector("circle"), "the spinner track");

        const arc = requireElement(spinner.querySelector("circle"), "arc");

        await expect(Math.round(indicator.getBoundingClientRect().width)).toBe(24);
        // Computed lengths can be fractional under browser zoom; compare snapped CSS pixels.
        await expect(Math.round(Number.parseFloat(getComputedStyle(svg).width))).toBe(16);
        await expect(spinner.querySelectorAll("circle")).toHaveLength(1);
        await expect(svg.getAnimations().length).toBe(0);
        await expect(spinner.getAnimations().length).toBe(1);
        await expect(track.getAnimations().length).toBe(0);

        // Reduced motion keeps the slow rotation but fixes the arc length.
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        await expect(arc.getAnimations().length).toBe(reducedMotion ? 0 : 1);
    },
};

export const Sizes: Story = {
    render: () => (
        <StoryRow>
            <LoadingIndicator size="sm" label="Small" />
            <LoadingIndicator size="no-container" label="No container" />
            <LoadingIndicator size="md" label="Medium" />
            <LoadingIndicator size="lg" label="Large" />
            <LoadingIndicator size="xl" label="Extra large" />
        </StoryRow>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const sizes = [
            { name: "Small", box: 16, glyph: 12 },
            { name: "No container", box: 16, glyph: 16 },
            { name: "Medium", box: 24, glyph: 16 },
            { name: "Large", box: 32, glyph: 20 },
            { name: "Extra large", box: 40, glyph: 24 },
        ];

        for (const { name, box, glyph } of sizes) {
            const indicator = canvas.getByRole("progressbar", { name });
            const svg = requireElement(indicator.querySelector("svg"), "svg");

            // Bounding boxes and computed lengths can be fractional at non-integer device pixel
            // ratios; compare snapped layout pixels instead of raw strings.
            await expect(Math.round(indicator.getBoundingClientRect().width)).toBe(box);
            await expect(Math.round(indicator.getBoundingClientRect().height)).toBe(box);
            await expect(Math.round(Number.parseFloat(getComputedStyle(svg).width))).toBe(glyph);
            await expect(Math.round(Number.parseFloat(getComputedStyle(svg).height))).toBe(glyph);
        }
    },
};

export const LabelledBy: Story = {
    render: () => (
        <div>
            <span id="loading-projects-label">Saving changes</span>
            <LoadingIndicator aria-labelledby="loading-projects-label" />
        </div>
    ),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        const indicator = canvas.getByRole("progressbar", { name: "Saving changes" });

        await expect(indicator).not.toHaveAttribute("aria-label");
        await expect(indicator).toHaveAttribute("aria-labelledby", "loading-projects-label");
    },
};

export const Dark: Story = {
    decorators: [DarkTheme],
    play: async ({ canvasElement }) => {
        await waitForDarkTheme();

        const canvas = within(canvasElement);
        const indicator = canvas.getByRole("progressbar", { name: "Loading" });

        await expect(getComputedStyle(indicator).color).toBe("rgb(0, 120, 212)");

        const track = requireElement(indicator.querySelector("circle"), "track");

        await expect(getComputedStyle(track).stroke).toBe("rgb(43, 43, 43)");
    },
};
