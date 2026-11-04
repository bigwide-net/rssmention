// Public feeds: posts (current and archives) and comments, each as JSON Feed and RSS.
import { getConfig, GroupConfig } from '../lib/config';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { isPostGuid, isValidGuid, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { FeedView, ItemView, renderJson, renderRss } from '../lib/render';
import { IncomingHttpRequest, RawResponse } from '../lib/server-common';
import { findComment, findPublishedPost, listArchives, PostMeta, readComments, readLog, readPostMeta, StoredItem } from '../lib/storage';
import { archiveFeedUrl, commentsFeedUrl, FeedFormat, itemUrl, mentionUrl, postsFeedUrl } from '../lib/urls';
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

// GET /groups/:group/comments/:post/comments.(json|xml) and /groups/:group/comments/:post/:parent/comments.(json|xml)
export function commentsFeedHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const group = getGroup(event.pathParameters.group);
        const postGuid = event.pathParameters.post;
        const parentGuid = event.pathParameters.parent ?? postGuid;
        if (!isPostGuid(postGuid) || !isValidGuid(parentGuid) || postGuidOf(parentGuid) != postGuid)
            throw new InvalidRequestError('Invalid guid');
        const meta: PostMeta | undefined = await readPostMeta(group.id, postGuid);
        const post = meta && await findPublishedPost(group.id, postGuid);
        if (!meta || !post) throw new NotFoundError('Unknown post');
        const parent = parentGuid == postGuid ? post : await findComment(group.id, parentGuid);
        if (!parent) throw new NotFoundError('Unknown comment');

        const what = parent.title ? `"${parent.title}"` : parentGuid == postGuid ? 'a post' : 'a comment';
        const items = await readComments(group.id, parentGuid);
        return respond(event, format, {
            group,
            title: `${group.name}: replies to ${what}`,
            description: group.topic,
            url: f => commentsFeedUrl(config, group.id, parentGuid, f),
            items: items.map(item => ({
                item,
                inReplyTo: f => itemUrl(config, group.id, parentGuid, f),
                comments: { feedUrl: f => commentsFeedUrl(config, group.id, item.id, f), count: meta.counts[item.id] ?? 0 },
            })),
        });
    };
}
