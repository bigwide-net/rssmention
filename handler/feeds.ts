// Public feeds: posts (current and archives) and comments, each as JSON Feed and RSS.
import { getConfig, GroupConfig } from '../lib/config';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { externalPostGuid, isPostGuid, isValidGuid, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { FeedView, ItemView, renderJson, renderRss, renderSubmissionsXml, submissionsJson } from '../lib/render';
import { IncomingHttpRequest, RawResponse } from '../lib/server-common';
import { findComment, findPublishedPost, listArchives, PostMeta, readComments, readLog, readPostMeta, StoredItem } from '../lib/storage';
import { archiveFeedUrl, commentsFeedUrl, externalFeedUrl, FeedFormat, itemUrl, mentionUrl, postsFeedUrl } from '../lib/urls';
import { getGroup } from './mention';

const CONTENT_TYPES: Record<FeedFormat, string> = {
    json: 'application/feed+json; charset=utf-8',
    xml: 'application/rss+xml; charset=utf-8',
};

function respond(event: IncomingHttpRequest, format: FeedFormat, feed: FeedView): RawResponse {
    const config = getConfig();
    event.responseHeaders = { ...event.responseHeaders, Link: `<${mentionUrl(config, feed.group.id)}>; rel="webmention"` };
    return new RawResponse(format == 'json' ? renderJson(config, feed) : renderRss(config, feed), CONTENT_TYPES[format]);
}

const MAX_EXTERNAL_GUID_LENGTH = 1024;

function requirePostsFeed(group: GroupConfig): void {
    if (group.externalFeeds)
        throw new NotFoundError('This group has no posts feed; its posts are in its external feeds');
}

// A guid in a URL fragment: encoded as little as possible, so that URL guids stay readable.
const fragment = (guid: string) => encodeURI(guid).replace(/#/g, '%23');

async function postViews(group: GroupConfig, items: StoredItem[]): Promise<ItemView[]> {
    const config = getConfig();
    const views: ItemView[] = [];
    for (const item of items) {
        const meta = await readPostMeta(group.id, item.id);
        views.push({
            item,
            comments: { feedUrl: f => commentsFeedUrl(config, group.id, item.id, f), count: meta?.counts[item.id] ?? 0, total: meta?.total ?? 0 },
            allowComments: meta?.allowComments ?? false,
        });
    }
    return views;
}

export function postsFeedHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const group = getGroup(event.pathParameters.group);
        requirePostsFeed(group);
        const archives = await listArchives(group.id, 'published');
        const newest = archives[archives.length - 1];
        return respond(event, format, {
            group,
            title: group.name,
            description: group.topic,
            url: f => postsFeedUrl(config, group.id, f),
            // The newest archive overlaps the current feed, so the first complete archive is the one before.
            prevArchiveUrl: newest > 1 ? f => archiveFeedUrl(config, group.id, newest - 1, f) : undefined,
            items: await postViews(group, await readLog(group.id, 'published')),
        });
    };
}

export async function archiveFeedHandler(_log: LogContext, event: IncomingHttpRequest) {
    const config = getConfig();
    const group = getGroup(event.pathParameters.group);
    requirePostsFeed(group);
    const m = /^posts-(\d{1,9})\.(json|xml)$/.exec(event.pathParameters.file ?? '');
    if (!m) throw new NotFoundError('Unknown archive');
    const n = Number(m[1]), format = m[2] as FeedFormat;
    if (!(await listArchives(group.id, 'published')).includes(n))
        throw new NotFoundError('Unknown archive');
    return respond(event, format, {
        group,
        title: `${group.name} (archive ${n})`,
        description: group.topic,
        url: f => archiveFeedUrl(config, group.id, n, f),
        prevArchiveUrl: n > 1 ? f => archiveFeedUrl(config, group.id, n - 1, f) : undefined,
        isArchive: true,
        items: await postViews(group, await readLog(group.id, 'published', n)),
    });
}

// GET /groups/:group/comments/:post/comments.(json|xml) and /groups/:group/comments/:post/:parent/comments.(json|xml).
// With external: GET /groups/:group/external/:guid/comments.(json|xml), the comments of a post in an
// external feed by its own guid (an empty feed before the first comment).
export function commentsFeedHandler(format: FeedFormat, options: { external?: boolean } = {}) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const group = getGroup(event.pathParameters.group);
        let postGuid: string, parentGuid: string;
        if (options.external) {
            const external = event.pathParameters.guid;
            if (!group.externalFeeds) throw new NotFoundError('This group has no external feeds');
            if (!external || external.length > MAX_EXTERNAL_GUID_LENGTH) throw new InvalidRequestError('Invalid guid');
            postGuid = parentGuid = externalPostGuid(group.id, external);
        } else {
            postGuid = event.pathParameters.post;
            parentGuid = event.pathParameters.parent ?? postGuid;
            if (!isPostGuid(postGuid) || !isValidGuid(parentGuid) || postGuidOf(parentGuid) != postGuid)
                throw new InvalidRequestError('Invalid guid');
        }
        const meta: PostMeta | undefined = await readPostMeta(group.id, postGuid);
        if (!meta && !options.external) throw new NotFoundError('Unknown post');

        let parent: StoredItem | undefined;
        if (parentGuid != postGuid) parent = await findComment(group.id, parentGuid);
        else if (meta && !meta.external) parent = await findPublishedPost(group.id, postGuid);
        if (!parent && (parentGuid != postGuid || (meta && !meta.external))) throw new NotFoundError(parentGuid == postGuid ? 'Unknown post' : 'Unknown comment');

        const what = parent?.title ? `"${parent.title}"` : parentGuid == postGuid ? 'a post' : 'a comment';
        const items = meta ? await readComments(group.id, parentGuid) : [];
        const inReplyTo = (f: FeedFormat) => parentGuid == postGuid && meta?.external
            ? `${externalFeedUrl(group.externalFeeds!, f)}#${fragment(meta.external)}`
            : itemUrl(config, group.id, parentGuid, f);
        return respond(event, format, {
            group,
            title: `${group.name}: replies to ${what}`,
            description: group.topic,
            url: f => commentsFeedUrl(config, group.id, parentGuid, f),
            items: items.map(item => ({
                item,
                inReplyTo,
                comments: { feedUrl: f => commentsFeedUrl(config, group.id, item.id, f), count: meta!.counts[item.id] ?? 0 },
            })),
        });
    };
}

// GET /groups/:group/submissions.(json|xml): the submissions element alone, for external feeds to include.
export function submissionsHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const group = getGroup(event.pathParameters.group);
        return format == 'json'
            ? { _submissions: submissionsJson(config, group) }
            : new RawResponse(renderSubmissionsXml(config, group), 'application/xml; charset=utf-8');
    };
}
