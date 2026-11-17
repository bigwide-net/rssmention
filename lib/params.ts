// Checks for request parameters (path, query and body). Each check either returns the validated (and,
// where needed, normalized) value or throws, so that handlers read their input in a single line:
//     const postGuid = checkPostGuid(event.pathParameters.post, 'post');
import { InvalidRequestError, NotFoundError } from './exceptions';
import { isPostGuid, isValidGuid } from './ids';
import { cleanLine, cleanText, hasForbiddenChars, isValidExternalGuid } from './sanitize';
import type { FeedFormat } from './urls';

export const MAX_URL_PARAM_LENGTH = 2048;

/** A guid of this server: a post or comment guid. */
export function checkGuid(s: unknown, name: string): string {
    if (typeof s != 'string' || !isValidGuid(s))
        throw new InvalidRequestError('Invalid guid ' + name);
    return s;
}

/** A post guid of this server. */
export function checkPostGuid(s: unknown, name: string): string {
    if (typeof s != 'string' || !isPostGuid(s))
        throw new InvalidRequestError('Invalid post guid ' + name);
    return s;
}

/** A comment guid of this server (not a post guid). */
export function checkCommentGuid(s: unknown, name: string): string {
    const guid = checkGuid(s, name);
    if (isPostGuid(guid))
        throw new InvalidRequestError('Invalid comment guid ' + name);
    return guid;
}

/** A guid of a comment below the given post (at any depth). */
export function checkCommentOfPost(s: unknown, postGuid: string, name: string): string {
    const guid = checkCommentGuid(s, name);
    if (!guid.startsWith(postGuid + '-'))
        throw new InvalidRequestError(`Invalid guid ${name}: not a comment of post ${postGuid}`);
    return guid;
}

/** The guid of a post in a foreign feed: printable ASCII of at most 512 characters. */
export function checkExternalGuid(s: unknown, name: string): string {
    if (!isValidExternalGuid(s))
        throw new InvalidRequestError(`Invalid guid ${name}: must be printable ASCII of at most 512 characters`);
    return s;
}

/** A feed file name like "post-42.json": the part before the extension and the format. Unknown files are 404. */
export function checkFeedFile(s: unknown, name: string): { base: string, format: FeedFormat } {
    const m = typeof s == 'string' ? /^(.+)\.(json|xml)$/s.exec(s) : null;
    if (!m)
        throw new NotFoundError(`Unknown ${name}`);
    return { base: m[1], format: m[2] as FeedFormat };
}

/** An archive file name like "posts-3.xml": the archive number and the format. Unknown files are 404. */
export function checkArchiveFile(s: unknown, name: string): { n: number, format: FeedFormat } {
    const m = typeof s == 'string' ? /^posts-(\d{1,9})\.(json|xml)$/.exec(s) : null;
    if (!m)
        throw new NotFoundError(`Unknown ${name}`);
    return { n: Number(m[1]), format: m[2] as FeedFormat };
}

/** A path segment that names one of a fixed set of resources. Unknown names are 404. */
export function checkPathName<T extends string>(s: unknown, name: string, values: readonly T[]): T {
    if (typeof s != 'string' || !(values as readonly string[]).includes(s))
        throw new NotFoundError(`Unknown ${name}`);
    return s as T;
}

/** One of the given values; `defaultValue` if the parameter is missing. */
export function checkEnum<T extends string>(s: unknown, name: string, values: readonly T[], defaultValue?: T): T {
    if (s === undefined && defaultValue !== undefined)
        return defaultValue;
    if (typeof s != 'string' || !(values as readonly string[]).includes(s))
        throw new InvalidRequestError(`${name} must be ${values.join(', ')}`);
    return s as T;
}

/** An optional positive integer (undefined if the parameter is missing). */
export function checkOptionalPositiveInt(s: unknown, name: string): number | undefined {
    if (s === undefined)
        return undefined;
    const n = typeof s == 'string' && /^\d{1,9}$/.test(s) ? Number(s) : NaN;
    if (!(n > 0))
        throw new InvalidRequestError(`${name} must be a positive integer`);
    return n;
}

export function checkBoolean(v: unknown, name: string): boolean {
    if (typeof v != 'boolean')
        throw new InvalidRequestError(`${name} must be a boolean`);
    return v;
}

/** Multi-line text of at most `max` characters, sanitized and not empty. */
export function checkText(v: unknown, name: string, max: number): string {
    if (typeof v != 'string' || v.length > max)
        throw new InvalidRequestError(`${name} must be a string of at most ${max} characters`);
    const text = cleanText(v).trim();
    if (!text)
        throw new InvalidRequestError(`${name} must not be empty`);
    return text;
}

/** An optional single line of at most `max` characters, sanitized; undefined if missing or blank. */
export function checkOptionalLine(v: unknown, name: string, max: number): string | undefined {
    if (v === undefined)
        return undefined;
    if (typeof v != 'string' || v.length > max)
        throw new InvalidRequestError(`${name} must be a string of at most ${max} characters`);
    return cleanLine(v, max) || undefined;
}

/**
 * A URL parameter: at most MAX_URL_PARAM_LENGTH characters without control or invisible characters.
 * Valid URLs are normalized to their href, which is pure ASCII; strings that don't parse are returned
 * trimmed, for the caller's more specific error message.
 */
export function checkUrlParam(v: unknown, name: string): string {
    if (typeof v != 'string' || !v.trim())
        throw new InvalidRequestError(`Missing parameter ${name}`);
    if (v.length > MAX_URL_PARAM_LENGTH)
        throw new InvalidRequestError(`Parameter ${name} is too long`);
    const trimmed = v.trim();
    if (hasForbiddenChars(trimmed))
        throw new InvalidRequestError(`Parameter ${name} contains invalid characters`);
    let href: string;
    try {
        href = new URL(trimmed).href;
    } catch {
        return trimmed;
    }
    if (href.length > MAX_URL_PARAM_LENGTH)
        throw new InvalidRequestError(`Parameter ${name} is too long`);
    return href;
}
