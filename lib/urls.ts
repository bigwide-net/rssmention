import { Config } from './config';
import { InvalidRequestError } from './exceptions';
import { externalPostGuid, isPostGuid, isValidGuid, parentGuidOf, postGuidOf } from './ids';

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

// The comments feed of a post in an external feed, addressed by the post's own guid. Blogs link it
// in source:comments; it serves the same items as commentsFeedUrl() for the derived post guid.
export function externalCommentsFeedUrl(config: Config, groupId: string, externalGuid: string, format: FeedFormat): string {
    return `${groupBaseUrl(config, groupId)}/external/${encodeURIComponent(externalGuid)}/comments.${format}`;
}

// The external feed to reference in the given format: the one with the matching extension, else the first.
export function externalFeedUrl(feeds: string[], format: FeedFormat): string {
    return feeds.find(f => new URL(f).pathname.endsWith('.' + format)) ?? feeds[0];
}

export function submissionsUrl(config: Config, groupId: string, format: FeedFormat): string {
    return `${groupBaseUrl(config, groupId)}/submissions.${format}`;
}

export function mentionUrl(config: Config, groupId: string): string {
    return `${groupBaseUrl(config, groupId)}/mention`;
}

export function statusUrl(config: Config, groupId: string, guid: string): string {
    return `${groupBaseUrl(config, groupId)}/status/${guid}`;
}

export type Target =
    | { kind: 'group' }            // a new post
    | { kind: 'post', guid: string, external?: string }   // a comment replying to a post (external: its guid in an external feed)
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
    const externalFeeds = config.groups[groupId]?.externalFeeds;
    if (externalFeeds) {
        const feed = new URL(url.href);
        feed.hash = '';
        if (externalFeeds.includes(feed.href)) {
            const external = decodeFragment(url.hash);
            if (!external)
                throw new InvalidRequestError('target must reference a post of the feed with #guid');
            return { kind: 'post', guid: externalPostGuid(groupId, external), external };
        }
    }
    const prefix = new URL(groupBaseUrl(config, groupId) + '/');
    if (url.origin != prefix.origin || !url.pathname.startsWith(prefix.pathname) || url.search)
        throw new InvalidRequestError(`target must be a feed of group ${groupId} on this server`);
    const path = url.pathname.substring(prefix.pathname.length);
    const fragment = decodeFragment(url.hash);

    if (/^posts\.(json|xml)$/.test(path) || /^archive\/posts-\d+\.(json|xml)$/.test(path)) {
        if (externalFeeds)
            throw new InvalidRequestError(`group ${groupId} has no posts feed; comment on the posts of its feed`);
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
