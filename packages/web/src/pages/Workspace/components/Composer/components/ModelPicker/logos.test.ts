import { describe, expect, it, vi } from "vitest";

import { createProviderLogoCache, isPlaceholderProviderSvg, parseProviderId } from "./logos";

const OPENAI_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';
const PLACEHOLDER_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path
    shape-rendering="geometricPrecision"
    d="M9.8132 15.9038L9 18.75L8.1868 15.9038C7.75968 14.4089 6.59112 13.2403 5.09619 12.8132L2.25 12L5.09619 11.1868C6.59113 10.7597 7.75968 9.59112 8.1868 8.09619L9 5.25L9.8132 8.09619C10.2403 9.59113 11.4089 10.7597 12.9038 11.1868L15.75 12L12.9038 12.8132C11.4089 13.2403 10.2403 14.4089 9.8132 15.9038Z"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>`;

describe("parseProviderId", () => {
    it("accepts valid provider slugs and rejects path traversal or separators", () => {
        expect(parseProviderId("openai")).toBe("openai");
        expect(parseProviderId("azure-openai_v2.1")).toBe("azure-openai_v2.1");
        expect(parseProviderId("")).toBeNull();
        expect(parseProviderId(".")).toBeNull();
        expect(parseProviderId("..")).toBeNull();
        expect(parseProviderId("foo/bar")).toBeNull();
        expect(parseProviderId("../secret")).toBeNull();
    });
});

describe("isPlaceholderProviderSvg", () => {
    it("detects models.dev unknown-provider sparkle placeholder", () => {
        expect(isPlaceholderProviderSvg(PLACEHOLDER_SVG)).toBe(true);
        expect(isPlaceholderProviderSvg(OPENAI_SVG)).toBe(false);
    });
});

describe("createProviderLogoCache", () => {
    it("caches fetched SVG logos for TTL, deduplicates concurrent fetches, and maps placeholders to missing", async () => {
        let now = 1_000;
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
            if (url.endsWith("/openai.svg")) {
                return Promise.resolve(
                    new Response(OPENAI_SVG, { status: 200, headers: { "content-type": "image/svg+xml" } }),
                );
            }
            return Promise.resolve(
                new Response(PLACEHOLDER_SVG, { status: 200, headers: { "content-type": "image/svg+xml" } }),
            );
        });

        const cache = createProviderLogoCache({
            fetch: fetchMock,
            nowMs: () => now,
            ttlMs: 10_000,
            retryMs: 2_000,
            storage: null,
        });

        const [first, second] = await Promise.all([cache.load("openai"), cache.load("openai")]);
        expect(first.kind).toBe("svg");
        expect(second).toEqual(first);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        expect(await cache.load("unknown-provider")).toEqual({ kind: "missing" });
        expect(await cache.load("unknown-provider")).toEqual({ kind: "missing" });
        expect(fetchMock).toHaveBeenCalledTimes(2);

        now += 2_000;
        await cache.load("unknown-provider");
        expect(fetchMock).toHaveBeenCalledTimes(3);

        now += 10_000;
        await cache.load("openai");
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it("does not fetch invalid provider slugs", async () => {
        const fetchMock = vi.fn();
        const cache = createProviderLogoCache({ fetch: fetchMock, storage: null });

        expect(await cache.load("../bad")).toEqual({ kind: "missing" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
