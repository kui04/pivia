import type { Decorator } from "@storybook/react-vite";
import { useEffect, type ReactNode } from "react";

function ThemeScope({ theme, children }: { theme: "light" | "dark"; children: ReactNode }) {
    useEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = theme;

        return () => {
            delete root.dataset.theme;
        };
    }, [theme]);

    return <>{children}</>;
}

/**
 * Pins the document theme for one story. The cleanup restores the system theme, so a story that
 * renders another story in the same preview cannot leak its theme.
 */
export const DarkTheme: Decorator = (Story) => (
    <ThemeScope theme="dark">
        <Story />
    </ThemeScope>
);

export const LightTheme: Decorator = (Story) => (
    <ThemeScope theme="light">
        <Story />
    </ThemeScope>
);
