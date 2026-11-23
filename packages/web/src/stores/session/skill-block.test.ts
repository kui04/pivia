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
});
