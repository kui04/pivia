import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { expect, waitFor, within } from "storybook/test";

import { LoadingIndicator } from "./LoadingIndicator";

function Row({ children }: { children: ReactNode }) {
    return <div style={{ display: "flex", alignItems: "center", gap: "var(--space-16)" }}>{children}</div>;
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

        const svg = indicator.querySelector("svg");
        const spinner = svg?.querySelector("g");
        const track = indicator.querySelector("circle");
        if (svg === null || spinner === null || spinner === undefined || track === null) {
            throw new Error("The loading indicator did not render a track and a spinner");
        }

        const arc = spinner.querySelector("circle");
        if (arc === null) {
            throw new Error("The loading indicator did not render an arc");
        }

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
        <Row>
            <LoadingIndicator size="sm" label="Small" />
            <LoadingIndicator size="no-container" label="No container" />
            <LoadingIndicator size="md" label="Medium" />
            <LoadingIndicator size="lg" label="Large" />
            <LoadingIndicator size="xl" label="Extra large" />
        </Row>
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
            const svg = indicator.querySelector("svg");
            if (svg === null) {
                throw new Error(`${name} did not render a spinner`);
            }

            // Bounding boxes and computed lengths can be fractional at non-integer device pixel
            // ratios; compare snapped layout pixels instead of raw strings.
            await expect(Math.round(indicator.getBoundingClientRect().width)).toBe(box);
            await expect(Math.round(indicator.getBoundingClientRect().height)).toBe(box);
            await expect(Math.round(Number.parseFloat(getComputedStyle(svg).width))).toBe(glyph);
            await expect(Math.round(Number.parseFloat(getComputedStyle(svg).height))).toBe(glyph);
        }
    },
};

export const CustomLabel: Story = {
    args: {
        label: "Loading projects",
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);

        await expect(canvas.getByRole("progressbar", { name: "Loading projects" })).toBeInTheDocument();
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
    decorators: [
        (Story) => (
            <DarkTheme>
                <Story />
            </DarkTheme>
        ),
    ],
    play: async ({ canvasElement }) => {
        await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark"));

        const canvas = within(canvasElement);
        const indicator = canvas.getByRole("progressbar", { name: "Loading" });

        await expect(getComputedStyle(indicator).color).toBe("rgb(0, 120, 212)");

        const track = indicator.querySelector("circle");
        if (track === null) {
            throw new Error("The loading indicator did not render a track");
        }

        await expect(getComputedStyle(track).stroke).toBe("rgb(43, 43, 43)");
    },
};
