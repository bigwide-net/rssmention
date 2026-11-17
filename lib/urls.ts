import { Config, SpaceConfig } from './config';
import { InvalidRequestError } from './exceptions';
import { externalPostGuid, isPostGuid, isValidGuid, parentGuidOf, postGuidOf } from './ids';
import { isValidExternalGuid } from './sanitize';

export type FeedFormat = 'json' | 'xml';

// The base URL of a group (/groups/<id>) or of the comments of a feed (/comments/<id>).
export function spaceBaseUrl(config: Config, space: SpaceConfig): string {
    return `${config.baseUrl}/${space.path}`;
}

export function postsFeedUrl(config: Config, space: SpaceConfig, format: FeedFormat): string {
    return `${spaceBaseUrl(config, space)}/posts.${format}`;
}

export function archiveFeedUrl(config: Config, space: SpaceConfig, n: number, format: FeedFormat): string {
    return `${spaceBaseUrl(config, space)}/archive/posts-${n}.${format}`;
}

// A guid in a URL fragment or path segment: encoded as little as possible, so that URLs stay readable.
export const encodeGuid = (guid: string) => encodeURI(guid).replace(/#/g, '%23');
const encodeGuidSegment = (guid: string) => encodeURI(guid).replace(/[#?/]/g, c => encodeURIComponent(c));

// Feeds only: the comments (and mentions) of a post of the feed, addressed by the post's own guid. The
// feed's owner links it in source:comments without asking the server.
export function postRepliesUrl(config: Config, space: SpaceConfig, externalGuid: string, format: FeedFormat): string {
    return `${spaceBaseUrl(config, space)}/post/${encodeGuidSegment(externalGuid)}.${format}`;
}

/**
 * The feed with the direct replies to `parentGuid` (a post or a comment). For feeds, replies to a post
 * are addressed by the post's own guid, which must be given as `externalGuid`.
 */
export function commentsFeedUrl(config: Config, space: SpaceConfig, parentGuid: string, format: FeedFormat, externalGuid?: string): string {
    const postGuid = postGuidOf(parentGuid);
    if (space.type == 'feed') {
        if (parentGuid != postGuid) return `${spaceBaseUrl(config, space)}/comment/${parentGuid}.${format}`;
        if (externalGuid === undefined) throw new Error('externalGuid is required for replies to feed posts');
        return postRepliesUrl(config, space, externalGuid, format);
    }
    const sub = parentGuid == postGuid ? '' : `/${parentGuid}`;
    return `${spaceBaseUrl(config, space)}/comments/${postGuid}${sub}/comments.${format}`;
}

// The feed that contains the item (post, comment or mention) with the given guid, plus #guid.
export function itemUrl(config: Config, space: SpaceConfig, guid: string, format: FeedFormat, externalGuid?: string): string {
    const parent = parentGuidOf(guid);
    const feed = parent ? commentsFeedUrl(config, space, parent, format, externalGuid) : postsFeedUrl(config, space, format);
    return `${feed}#${encodeGuid(guid)}`;
}

// A post of the configured feed as a reference: the feed URL in the given format (the one with the
// matching extension, else the first) plus #guid.
export function feedPostRef(space: SpaceConfig, externalGuid: string, format: FeedFormat): string {
    const feeds = space.feeds!;
    const feed = feeds.find(f => new URL(f).pathname.endsWith('.' + format)) ?? feeds[0];
    return `${feed}#${encodeGuid(externalGuid)}`;
}

export function submissionsUrl(config: Config, space: SpaceConfig, format: FeedFormat): string {
    return `${spaceBaseUrl(config, space)}/submissions.${format}`;
}

export function mentionUrl(config: Config, space: SpaceConfig): string {
    return `${spaceBaseUrl(config, space)}/mention`;
}

export function statusUrl(config: Config, space: SpaceConfig, guid: string): string {
    return `${spaceBaseUrl(config, space)}/status/${guid}`;
}

export type Target =
    | { kind: 'group' }            // a new post
    | { kind: 'post', guid: string, external?: string }   // replying to a post (external: its guid in the feed of a feedComments space)
    | { kind: 'comment', guid: string }; // a comment replying to a comment

function decodeFragment(hash: string): string {
    try {
        return decodeURIComponent(hash.replace(/^#/, ''));
    } catch {
        return hash.replace(/^#/, '');
    }
}

function decodeSegment(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

function commentTarget(fragment: string, feedParent: string): Target {
    if (!fragment)
        throw new InvalidRequestError('comment targets require a #guid fragment');
    if (!isValidGuid(fragment) || isPostGuid(fragment) || parentGuidOf(fragment) != feedParent)
        throw new InvalidRequestError('target fragment does not reference a comment in this feed');
    return { kind: 'comment', guid: fragment };
}

// Targets of a feedComments space: <feed URL>#<post guid>, or a comment in one of its replies feeds.
function parseFeedTarget(config: Config, space: SpaceConfig, url: URL): Target {
    const feed = new URL(url.href);
    feed.hash = '';
    if (space.feeds!.includes(feed.href)) {
        const external = decodeFragment(url.hash);
        if (!external)
            throw new InvalidRequestError('target must reference a post of the feed with #guid');
        if (!isValidExternalGuid(external))
            throw new InvalidRequestError('the guid in the target fragment must be printable ASCII of at most 512 characters');
        return { kind: 'post', guid: externalPostGuid(space.id, external), external };
    }
    const prefix = new URL(spaceBaseUrl(config, space) + '/');
    if (url.origin != prefix.origin || !url.pathname.startsWith(prefix.pathname) || url.search)
        throw new InvalidRequestError(`target must be a post of ${space.feeds![0]} or a comment in one of its replies feeds`);
    const path = url.pathname.substring(prefix.pathname.length);
    const m = /^(post|comment)\/([^/]+)\.(json|xml)$/.exec(path);
    if (!m)
        throw new InvalidRequestError(`target must be a post of ${space.feeds![0]} or a comment in one of its replies feeds`);
    const segment = decodeSegment(m[2]);
    if (!isValidExternalGuid(segment))
        throw new InvalidRequestError('target does not reference a valid post or comment');
    const feedParent = m[1] == 'post' ? externalPostGuid(space.id, segment) : segment;
    return commentTarget(decodeFragment(url.hash), feedParent);
}

/**
 * Parses a webmention target. For groups, accepted are the group's posts feed (new post), the posts
 * feed or a posts archive with #post-guid (comment on a post), and the comments feed containing a
 * comment with #comment-guid (reply to that comment). The .xml and .json variants are equivalent.
 * For feeds, see parseFeedTarget().
 */
export function parseTarget(config: Config, space: SpaceConfig, target: string): Target {
    let url: URL;
    try {
        url = new URL(target);
    } catch {
        throw new InvalidRequestError('target is not a valid URL');
    }
    if (space.type == 'feed')
        return parseFeedTarget(config, space, url);
    const prefix = new URL(spaceBaseUrl(config, space) + '/');
    if (url.origin != prefix.origin || !url.pathname.startsWith(prefix.pathname) || url.search)
        throw new InvalidRequestError(`target must be a feed of group ${space.id} on this server`);
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
        const target = commentTarget(fragment, m[2] ?? m[1]);
        if (postGuidOf((target as { guid: string }).guid) != m[1])
            throw new InvalidRequestError('target fragment does not reference a comment in this feed');
        return target;
    }
    throw new InvalidRequestError(`target must be a feed of group ${space.id} on this server`);
}

/**
 * Normalizes a feed reference for comparison: .xml and .json variants are equal, the fragment is
 * decoded. With a space, all URLs of its `feeds` count as the same feed.
 */
export function normalizeFeedRef(ref: string, space?: SpaceConfig): string | undefined {
    try {
        const url = new URL(ref.trim());
        const fragment = decodeFragment(url.hash);
        url.hash = '';
        if (space?.feeds?.includes(url.href))
            return space.feeds[0] + (fragment ? '#' + fragment : '');
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
