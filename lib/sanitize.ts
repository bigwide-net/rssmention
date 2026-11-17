// Sanitizing of untrusted strings from the network (request parameters and fetched feeds).
//
// Identifiers (URLs, guids) are reduced to printable ASCII: URLs by normalizing them to their href,
// which percent-encodes everything else; foreign guids by rejecting anything that isn't printable ASCII.
// Text meant for people (titles, names, content) keeps printable Unicode, so non-English text works,
// but loses everything invisible or structural: control characters, bidi overrides and isolates,
// zero-width and other format characters, unpaired surrogates and noncharacters. Line and paragraph
// separators become newlines. The result is always valid in XML 1.0 and safe to log.

// Display names (authors).
export const MAX_NAME_LENGTH = 100;
// Guids of posts in foreign feeds (path parameters, fragments).
export const MAX_EXTERNAL_GUID_LENGTH = 512;
// Single-line fields of fetched feeds before their specific validation (titles, URLs, accounts, guids).
export const MAX_FEED_FIELD_LENGTH = 2048;
// Content of failed submissions that is kept for the admin, and values quoted in failure texts.
export const MAX_FAILED_CONTENT_LENGTH = 10000;
export const MAX_FAILURE_TEXT_LENGTH = 1000;
export const MAX_QUOTE_LENGTH = 100;

// Plane noncharacters U+xFFFE and U+xFFFF of the supplementary planes 1-16.
const PLANE_NONCHARS = Array.from({ length: 16 }, (_, i) => {
    const p = (i + 1).toString(16).toUpperCase();
    return `\\u{${p}FFFE}\\u{${p}FFFF}`;
}).join('');

/**
 * Characters that never survive sanitizing (\t, \n and \r are handled separately):
 * C0 controls, DEL and C1 controls; soft hyphen; combining grapheme joiner; Mongolian vowel separator;
 * zero width space; LRM/RLM/ALM; bidi embeddings, overrides and isolates; word joiner and invisible
 * operators; deprecated format characters; BOM / zero width no-break space; interlinear annotation;
 * noncharacters; unpaired surrogates. ZWJ and ZWNJ are kept: emoji sequences and several scripts need them.
 */
const FORBIDDEN_SOURCE =
    '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u034F\\u061C\\u180E\\u200B\\u200E\\u200F' +
    '\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB\\uFDD0-\\uFDEF\\uFFFE\\uFFFF' + PLANE_NONCHARS + ']|\\p{Cs}';
const FORBIDDEN = new RegExp(FORBIDDEN_SOURCE, 'gu');
const FORBIDDEN_OR_CONTROL = new RegExp(FORBIDDEN_SOURCE + '|[\\t\\n\\r\\u2028\\u2029]', 'u');

/** True if the code point would be removed by sanitizing (used for decoded character references). */
export function isForbiddenCodePoint(cp: number): boolean {
    FORBIDDEN.lastIndex = 0;
    return FORBIDDEN.test(String.fromCodePoint(cp));
}

/** True if the string contains a character that sanitizing would remove, or a line break or tab. */
export function hasForbiddenChars(s: string): boolean {
    return FORBIDDEN_OR_CONTROL.test(s);
}

/** Cuts the string to at most `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    const cut = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
    return s.substring(0, cut);
}

/**
 * Multi-line text (content, Markdown, HTML): NFC-normalized, line breaks unified to \n, forbidden
 * characters removed. Tabs and newlines are kept. Not truncated: content limits are checked later.
 */
export function cleanText(s: string): string {
    return s.normalize('NFC').replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(FORBIDDEN, '');
}

/** Single-line text (titles, names, accounts, URLs): like cleanText, all whitespace runs become one space, trimmed. */
export function cleanLine(s: string, max = MAX_FEED_FIELD_LENGTH): string {
    return truncate(cleanText(s).replace(/\s+/g, ' ').trim(), max);
}

/** A short excerpt of an untrusted value for an error message. */
export function quote(s: string | undefined, max = MAX_QUOTE_LENGTH): string {
    if (s === undefined) return '';
    const line = cleanLine(s, max + 1);
    return line.length > max ? truncate(line, max) + '…' : line;
}

/** True for guids of foreign feeds that may be used as identifiers: 1-512 characters of printable ASCII. */
export function isValidExternalGuid(guid: unknown): guid is string {
    return typeof guid == 'string' && guid.length > 0 && guid.length <= MAX_EXTERNAL_GUID_LENGTH && /^[\x20-\x7E]+$/.test(guid);
}

/** The ASCII href of an absolute http(s) URL of at most `max` characters, else undefined. */
export function httpUrl(s: string | undefined, max: number): string | undefined {
    if (!s) return undefined;
    try {
        const url = new URL(s);
        if (url.protocol != 'http:' && url.protocol != 'https:') return undefined;
        return url.href.length <= max ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** Makes an untrusted value safe for a single log line: control, bidi and other invisible characters are escaped. */
export function escapeForLog(s: string): string {
    return s.replace(new RegExp(FORBIDDEN_SOURCE + '|[\\t\\n\\r\\u2028\\u2029]', 'gu'),
        c => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

/** Removes characters that are invalid in XML 1.0 even when escaped (last line of defense in the renderer). */
export function stripXmlInvalid(s: string): string {
    return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\p{Cs}/gu, '');
}
