import fs from 'node:fs';

// Page titles that must never be synced to a site, keyed by site id.
// A "*" key applies to every site.
export type excluded_pages = Map<string, string[]>;

// MediaWiki treats the first letter of a title case-insensitively and the rest
// case-sensitively, so normalize only the first letter before comparing.
function normalize_title(title : string) : string {
    const cleaned = title.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length === 0) return cleaned;

    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
};

function matches_pattern(title : string, pattern : string) : boolean {
    const normalized_title = normalize_title(title);

    // "Template:DOORS Wiki/*" matches the page itself and every subpage,
    // at any depth.
    if (pattern.endsWith('/*')) {
        const prefix = normalize_title(pattern.slice(0, -2));
        if (normalized_title === prefix) return true;

        return normalized_title.startsWith(`${prefix}/`);
    };

    return normalized_title === normalize_title(pattern);
};

export function load_excluded_pages(file_path : string, site_ids : Set<string>) : excluded_pages {
    if (!fs.existsSync(file_path)) return new Map();

    let raw : unknown;
    try {
        raw = JSON.parse(fs.readFileSync(file_path, 'utf8'));
    } catch (err : unknown) {
        throw new Error(`WikiWire: could not parse ${file_path}: ${err instanceof Error ? err.message : String(err)}`);
    };

    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`WikiWire: ${file_path} must be a JSON object mapping site ids to arrays of page titles`);
    };

    const known = [...site_ids].sort().join(', ');
    const excluded : excluded_pages = new Map();

    for (const [site_id, value] of Object.entries(raw as Record<string, unknown>)) {
        if (site_id !== '*' && !site_ids.has(site_id)) {
            throw new Error(`WikiWire: ${file_path} lists unknown site id "${site_id}" (expected one of: ${known}, or "*")`);
        };

        if (!Array.isArray(value)) {
            throw new Error(`WikiWire: ${file_path} entry "${site_id}" must be an array of page titles`);
        };

        const titles : string[] = [];
        for (const entry of value) {
            if (typeof entry !== 'string' || entry.trim().length === 0) {
                throw new Error(`WikiWire: ${file_path} entry "${site_id}" contains an empty or non-string page title`);
            };

            titles.push(entry.trim());
        };

        excluded.set(site_id, titles);
    };

    return excluded;
};

export function is_title_excluded(excluded : excluded_pages, site_id : string, title : string) : boolean {
    const patterns = [
        ...(excluded.get('*') ?? []),
        ...(excluded.get(site_id) ?? []),
    ];

    return patterns.some((pattern) => matches_pattern(title, pattern));
};
