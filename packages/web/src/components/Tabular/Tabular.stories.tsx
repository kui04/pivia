import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ensureFontRole } from "@/lib";

import { Tabular } from "./Tabular";

const meta = {
    title: "Components/Tabular",
    component: Tabular,
    args: {
        children: "12:34.5",
    },
} satisfies Meta<typeof Tabular>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FixedDigitWidths: Story = {
    render: () => (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--space-4)" }}>
            <Tabular data-testid="ones">1111111111</Tabular>
            <Tabular data-testid="eights">8888888888</Tabular>
        </div>
    ),
    play: async ({ canvasElement }) => {
        await ensureFontRole("sans");
        await document.fonts.ready;
        const canvas = within(canvasElement);
        const ones = canvas.getByTestId("ones");
        const eights = canvas.getByTestId("eights");

        await expect(ones.getBoundingClientRect().width).toBeCloseTo(eights.getBoundingClientRect().width, 1);
    },
};
