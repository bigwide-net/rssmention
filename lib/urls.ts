import { Config } from './config';
import { InvalidRequestError } from './exceptions';
import { isPostGuid, isValidGuid, parentGuidOf, postGuidOf } from './ids';

export type FeedFormat = 'json' | 'xml';

export function groupBaseUrl(config: Config, groupId: string): string {
    return `${config.baseUrl}/groups/${groupId}`;
}

export function postsFeedUrl(config: Config, groupId: string, format: FeedFormat): string {
    return `${groupBaseUrl(config, groupId)}/posts.${format}`;
}

export function archiveFeedUrl(config: Config, groupId: string, n: number, format: FeedFormat): string {
    return `${groupBaseUrl(config, groupId)}/archive/posts-${n}.${format}`;
}

// The feed with the direct replies to `parentGuid` (a post or a comment).
export function commentsFeedUrl(config: Config, groupId: string, parentGuid: string, format: FeedFormat): string {
    const postGuid = postGuidOf(parentGuid);
    const sub = parentGuid == postGuid ? '' : `/${parentGuid}`;
    return `${groupBaseUrl(config, groupId)}/comments/${postGuid}${sub}/comments.${format}`;
}

// The feed that contains the item with the given guid, plus #guid.
export function itemUrl(config: Config, groupId: string, guid: string, format: FeedFormat): string {
    const parent = parentGuidOf(guid);
    const feed = parent ? commentsFeedUrl(config, groupId, parent, format) : postsFeedUrl(config, groupId, format);
    return `${feed}#${guid}`;
}

export function mentionUrl(config: Config, groupId: string): string {
    return `${groupBaseUrl(config, groupId)}/mention`;
}

export function statusUrl(config: Config, groupId: string, guid: string): string {
    return `${groupBaseUrl(config, groupId)}/status/${guid}`;
}

export type Target =
    | { kind: 'group' }            // a new post
    | { kind: 'post', guid: string }   // a comment replying to a post
    | { kind: 'comment', guid: string }; // a comment replying to a comment

function decodeFragment(hash: string): string {
    try {
        return decodeURIComponent(hash.replace(/^#/, ''));
    } catch {
        return hash.replace(/^#/, '');
    }
}

/**
 * Parses a webmention target. Accepted are this group's posts feed (new post), the posts feed or a
 * posts archive with #post-guid (comment on a post), and the comments feed containing a comment with
 * #comment-guid (reply to that comment). The .xml and .json variants are equivalent.
 */
export function parseTarget(config: Config, groupId: string, target: string): Target {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        throw new InvalidRequestError('target is not a valid URL');
    }
    const prefix = new URL(groupBaseUrl(config, groupId) + '/');
    if (url.origin != prefix.origin || !url.pathname.startsWith(prefix.pathname) || url.search)
        throw new InvalidRequestError(`target must be a feed of group ${groupId} on this server`);
    const path = url.pathname.substring(prefix.pathname.length);
    const fragment = decodeFragment(url.hash);

    if (/^posts\.(json|xml)$/.test(path) || /^archive\/posts-\d+\.(json|xml)$/.test(path)) {
        if (!fragment) {
            if (path.startsWith('archive/'))
                throw new InvalidRequestError('new posts must target the posts feed, not an archive');
            return { kind: 'group' };
        }
        if (!isPostGuid(fragment))
            throw new InvalidRequestError('target fragment is not a post guid of this group');
        return { kind: 'post', guid: fragment };
    }
    const m = /^comments\/([^/]+)(?:\/([^/]+))?\/comments\.(json|xml)$/.exec(path);
    if (m) {
        const feedParent = m[2] ?? m[1];
        if (!fragment)
            throw new InvalidRequestError('comment targets require a #guid fragment');
        if (!isValidGuid(fragment) || isPostGuid(fragment) || parentGuidOf(fragment) != feedParent || postGuidOf(fragment) != m[1])
            throw new InvalidRequestError('target fragment does not reference a comment in this feed');
        return { kind: 'comment', guid: fragment };
    }
    throw new InvalidRequestError(`target must be a feed of group ${groupId} on this server`);
}

// Normalizes a feed reference for comparison: .xml and .json variants are equal, fragment decoded.
export function normalizeFeedRef(ref: string): string | undefined {
    try {
        const url = new URL(ref.trim());
        const fragment = decodeFragment(url.hash);
        url.hash = '';
        url.pathname = url.pathname.replace(/\.xml$/, '.json');
        return url.href + (fragment ? '#' + fragment : '');
    } catch {
        return undefined;
    }
}

// The source URL as a stable key, used to recognize re-sent webmentions (edits and deletes).
export function sourceKey(source: string): string {
    return new URL(source).href;
}
