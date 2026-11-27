import type { Meta, StoryObj } from "@storybook/react-vite";
import { Check, Plus, Search, X } from "lucide-react";
import type { CSSProperties } from "react";
import { expect } from "storybook/test";

import { StoryRow } from "@/storybook/frames";

import { Icon } from "./Icon";

// getBoundingClientRect is fractional at non-integer device pixel ratios; compare snapped CSS
// pixels so the same layout passes in the CLI and in a zoomed or scaled browser.
function boxWidths(canvasElement: HTMLElement) {
    return [...canvasElement.querySelectorAll("svg")].map((glyph) =>
        Math.round(glyph.parentElement?.getBoundingClientRect().width ?? 0),
    );
}

function glyphWidths(canvasElement: HTMLElement) {
    return [...canvasElement.querySelectorAll("svg")].map((glyph) => Math.round(glyph.getBoundingClientRect().width));
}

const meta = {
    title: "Components/Icon",
    component: Icon,
    args: {
        children: <Plus />,
    },
} satisfies Meta<typeof Icon>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
    play: async ({ canvasElement }) => {
        const glyph = canvasElement.querySelector("svg");
        const box = glyph?.parentElement;

        if (glyph === null || box === null || box === undefined) {
            throw new Error("The story did not render an svg inside the icon box");
        }

        await expect(box).toHaveAttribute("aria-hidden", "true");
        await expect(Math.round(glyph.getBoundingClientRect().width)).toBe(16);
        await expect(Math.round(box.getBoundingClientRect().width)).toBe(24);
    },
};

export const Sizes: Story = {
    render: () => (
        <StoryRow gap="var(--space-24)">
            <Icon size="sm">
                <Plus />
            </Icon>
            <Icon size="md">
                <Plus />
            </Icon>
            <Icon size="lg">
                <Plus />
            </Icon>
            <Icon size="xl">
                <Plus />
            </Icon>
            <Icon size="no-container">
                <Plus />
            </Icon>
        </StoryRow>
    ),
    play: async ({ canvasElement }) => {
        await expect(boxWidths(canvasElement)).toEqual([16, 24, 32, 40, 16]);
        await expect(glyphWidths(canvasElement)).toEqual([12, 16, 20, 24, 16]);
    },
};

export const Overrides: Story = {
    render: () => (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-16)" }}>
            <StoryRow gap="var(--space-24)">
                <Icon glyphSize={12}>
                    <Search />
                </Icon>
                <Icon glyphSize={20}>
                    <Search />
                </Icon>
            </StoryRow>
            <StoryRow gap="var(--space-24)">
                <Icon padding={0}>
                    <X />
                </Icon>
                <Icon padding={8}>
                    <X />
                </Icon>
            </StoryRow>
            <StoryRow gap="var(--space-24)">
                <Icon boxSize={32}>
                    <Check />
                </Icon>
                <Icon boxSize={40}>
                    <Check />
                </Icon>
            </StoryRow>
            <StoryRow gap="var(--space-24)">
                <Icon
                    style={
                        {
                            "--icon-padding-inline-start": "0px",
                        } as CSSProperties
                    }
                >
                    <Check />
                </Icon>
            </StoryRow>
        </div>
    ),
    play: async ({ canvasElement }) => {
        // Only the start padding drops on the last icon, so its 24px box becomes 20px wide.
        await expect(boxWidths(canvasElement)).toEqual([20, 28, 16, 32, 32, 40, 20]);
        await expect(glyphWidths(canvasElement)).toEqual([12, 20, 16, 16, 16, 16, 16]);
    },
};
