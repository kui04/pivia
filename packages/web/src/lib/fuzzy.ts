/** Match score returned by {@link Fuzzy.match}. Lower score indicates a stronger match. */
export interface FuzzyMatch {
    readonly matches: boolean;
    readonly score: number;
}

/** Fuzzy matching helpers aligned with `@earendil-works/pi-tui`. */
export type Fuzzy = {
    /** Match a single token against `text` using pi-tui's fuzzy ranking rules. */
    match(query: string, text: string): FuzzyMatch;
    /** Filter and rank `items` by whitespace/slash-delimited query tokens, best match first. */
    filter<T>(items: readonly T[], query: string, getText: (item: T) => string): readonly T[];
};

const WORD_BOUNDARY_RE = /[\s\-_./:]/;
const ALPHA_NUMERIC_RE = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/;
const NUMERIC_ALPHA_RE = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/;

function scorePositions(textLower: string, positions: readonly number[]): number {
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    for (const index of positions) {
        if (lastMatchIndex === index - 1) {
            consecutiveMatches += 1;
            score -= consecutiveMatches * 5;
        } else {
            consecutiveMatches = 0;
            if (lastMatchIndex >= 0) {
                score += (index - lastMatchIndex - 1) * 2;
            }
        }

        const prevChar = index > 0 ? textLower[index - 1] : undefined;
        if (index === 0 || (prevChar !== undefined && WORD_BOUNDARY_RE.test(prevChar))) {
            score -= 10;
        }

        score += index * 0.1;
        lastMatchIndex = index;
    }

    return score;
}

function matchQuery(normalizedQuery: string, textLower: string): FuzzyMatch {
    if (normalizedQuery.length === 0) {
        return { matches: true, score: 0 };
    }
    if (normalizedQuery.length > textLower.length) {
        return { matches: false, score: 0 };
    }

    const positions: number[] = [];
    let lastMatchIndex = -1;
    for (let queryIndex = 0; queryIndex < normalizedQuery.length; queryIndex += 1) {
        const ch = normalizedQuery[queryIndex];
        if (ch === undefined) {
            return { matches: false, score: 0 };
        }
        const foundAt = textLower.indexOf(ch, lastMatchIndex + 1);
        if (foundAt === -1) {
            return { matches: false, score: 0 };
        }
        positions.push(foundAt);
        lastMatchIndex = foundAt;
    }

    let score = scorePositions(textLower, positions);

    // Also score every contiguous occurrence so an early scattered hit does not hide a later exact segment.
    for (
        let start = textLower.indexOf(normalizedQuery);
        start !== -1;
        start = textLower.indexOf(normalizedQuery, start + 1)
    ) {
        for (let k = 0; k < positions.length; k += 1) {
            positions[k] = start + k;
        }
        score = Math.min(score, scorePositions(textLower, positions));
    }

    if (normalizedQuery === textLower) {
        score -= 100;
    }

    return { matches: true, score };
}

function fuzzyMatch(query: string, text: string): FuzzyMatch {
    const queryLower = query.toLowerCase();
    const textLower = text.toLowerCase();
    const primaryMatch = matchQuery(queryLower, textLower);
    if (primaryMatch.matches) {
        return primaryMatch;
    }

    const alphaNumericMatch = ALPHA_NUMERIC_RE.exec(queryLower);
    const numericAlphaMatch = NUMERIC_ALPHA_RE.exec(queryLower);
    const swappedQuery =
        alphaNumericMatch?.groups !== undefined
            ? `${alphaNumericMatch.groups.digits ?? ""}${alphaNumericMatch.groups.letters ?? ""}`
            : numericAlphaMatch?.groups !== undefined
              ? `${numericAlphaMatch.groups.letters ?? ""}${numericAlphaMatch.groups.digits ?? ""}`
              : "";

    if (swappedQuery.length === 0) {
        return primaryMatch;
    }

    const swappedMatch = matchQuery(swappedQuery, textLower);
    if (!swappedMatch.matches) {
        return primaryMatch;
    }
    return { matches: true, score: swappedMatch.score + 5 };
}

function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): readonly T[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
        return items;
    }

    const tokens = trimmed.split(/[\s/]+/).filter((token) => token.length > 0);
    if (tokens.length === 0) {
        return items;
    }

    const results: { item: T; totalScore: number }[] = [];
    for (const item of items) {
        const text = getText(item);
        let totalScore = 0;
        let allMatch = true;

        for (const token of tokens) {
            const match = fuzzyMatch(token, text);
            if (match.matches) {
                totalScore += match.score;
            } else {
                allMatch = false;
                break;
            }
        }

        if (allMatch) {
            results.push({ item, totalScore });
        }
    }

    results.sort((left, right) => left.totalScore - right.totalScore);
    return results.map((result) => result.item);
}

/** App-wide fuzzy matcher and filter helper. */
export const Fuzzy: Fuzzy = {
    match: fuzzyMatch,
    filter: fuzzyFilter,
};
