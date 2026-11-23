import { parseSkillBlock as sdkParseSkillBlock } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { parseSkillBlock } from "./skill-block";

function skillBlock(name: string, location: string, body: string, prompt?: string): string {
    const block = `<skill name="${name}" location="${location}">\n${body}\n</skill>`;
    return prompt === undefined ? block : `${block}\n\n${prompt}`;
}

describe("parseSkillBlock", () => {
    it("splits the block fields and the prompt typed after the command", () => {
        const text = skillBlock(
            "tydd",
            "/home/kui04/.pi/agent/skills/tydd/SKILL.md",
            "References are relative to /home/kui04/.pi/agent/skills/tydd.\n\n## Role\n\nAct.",
            "  Review this diff  ",
        );

        expect(parseSkillBlock(text)).toEqual({
            name: "tydd",
            location: "/home/kui04/.pi/agent/skills/tydd/SKILL.md",
            content: "References are relative to /home/kui04/.pi/agent/skills/tydd.\n\n## Role\n\nAct.",
            userMessage: "Review this diff",
        });
    });

    it("returns no user message when the command had no prompt", () => {
        const parsed = parseSkillBlock(skillBlock("tydd", "/skills/tydd/SKILL.md", "Body"));

        expect(parsed).toEqual({
            name: "tydd",
            location: "/skills/tydd/SKILL.md",
            content: "Body",
            userMessage: undefined,
        });
    });

    it("keeps a closing tag that appears inside the body", () => {
        const parsed = parseSkillBlock(
            skillBlock("tydd", "/skills/tydd/SKILL.md", "Write the tag\n</skill>\ninside prose"),
        );

        expect(parsed?.content).toBe("Write the tag\n</skill>\ninside prose");
    });

    it("keeps an empty body", () => {
        expect(parseSkillBlock(skillBlock("tydd", "/skills/tydd/SKILL.md", ""))?.content).toBe("");
    });

    it("does not treat plain text or a partial block as an invocation", () => {
        expect(parseSkillBlock("Explain the <skill> tag of a session file.")).toBeNull();
        expect(parseSkillBlock('<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody')).toBeNull();
        expect(
            parseSkillBlock('<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill> trailing'),
        ).toBeNull();
        expect(parseSkillBlock('  <skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>')).toBeNull();
    });

    it("requires a non-empty name and location", () => {
        expect(parseSkillBlock('<skill name="" location="/skills/x/SKILL.md">\nBody\n</skill>')).toBeNull();
        expect(parseSkillBlock('<skill name="x" location="">\nBody\n</skill>')).toBeNull();
    });

    /**
     * Every input the transcript can hand the parser.
     *
     * The browser cannot import the SDK parser (it pulls Node built-ins), so the web module mirrors
     * it. These cases pin the mirror to the installed SDK; a release that changes the block format
     * fails here instead of silently rendering skill bodies as user text.
     */
    const CORPUS: readonly string[] = [
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>\n\nReview this diff',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nLine one\nLine two\n</skill>',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nWrite the tag\n</skill>\ninside prose\n</skill>',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\n\n</skill>',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>\n\n   ',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>\n\ntrailing\n\nparagraph',
        "Explain the <skill> tag of a session file.",
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody',
        '<skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill> trailing',
        '  <skill name="tydd" location="/skills/tydd/SKILL.md">\nBody\n</skill>',
        '<skill name="" location="/skills/x/SKILL.md">\nBody\n</skill>',
        '<skill name="x" location="">\nBody\n</skill>',
    ];

    describe("parity with the SDK", () => {
        it.each(CORPUS)("matches the sdk parser for %#", (text) => {
            expect(parseSkillBlock(text)).toEqual(sdkParseSkillBlock(text));
        });

        it("matches the block the terminal client expands a /skill command into", () => {
            const expanded = [
                '<skill name="tydd" location="/home/kui04/.pi/agent/skills/tydd/SKILL.md">',
                "References are relative to /home/kui04/.pi/agent/skills/tydd.",
                "",
                "# Type-Driven Development",
                "</skill>",
                "",
                "Review this diff",
            ].join("\n");

            expect(parseSkillBlock(expanded)).toEqual(sdkParseSkillBlock(expanded));
            expect(parseSkillBlock(expanded)?.userMessage).toBe("Review this diff");
        });
    });
});
