// Public feeds: posts (current and archives) and comments, each as JSON Feed and RSS.
import { getConfig, SpaceConfig } from '../lib/config';
import { NotFoundError } from '../lib/exceptions';
import { externalPostGuid, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { FeedView, ItemView, renderJson, renderRss, renderSubmissionsXml, submissionsJson } from '../lib/render';
import { checkArchiveFile, checkCommentGuid, checkCommentOfPost, checkEnum, checkExternalGuid, checkFeedFile, checkPostGuid } from '../lib/params';
import { IncomingHttpRequest, RawResponse } from '../lib/server-common';
import { findComment, findPublishedPost, listArchives, PostMeta, readComments, readLog, readMentions, readPostMeta, StoredItem } from '../lib/storage';
import { archiveFeedUrl, commentsFeedUrl, feedPostRef, FeedFormat, itemUrl, mentionUrl, postsFeedUrl } from '../lib/urls';
import { getSpace } from './mention';

const CONTENT_TYPES: Record<FeedFormat, string> = {
    json: 'application/feed+json; charset=utf-8',
    xml: 'application/rss+xml; charset=utf-8',
};

function respond(event: IncomingHttpRequest, format: FeedFormat, feed: FeedView): RawResponse {
    const config = getConfig();
    event.responseHeaders = { ...event.responseHeaders, Link: `<${mentionUrl(config, feed.space)}>; rel="webmention"` };
    return new RawResponse(format == 'json' ? renderJson(config, feed) : renderRss(config, feed), CONTENT_TYPES[format]);
}

function getGroup(event: IncomingHttpRequest): SpaceConfig {
    const space = getSpace(event);
    if (space.type != 'group') throw new NotFoundError('Unknown group');
    return space;
}

async function postViews(group: SpaceConfig, items: StoredItem[]): Promise<ItemView[]> {
    const config = getConfig();
    const views: ItemView[] = [];
    for (const item of items) {
        const meta = await readPostMeta(group.path, item.id);
        views.push({
            item,
            comments: { feedUrl: f => commentsFeedUrl(config, group, item.id, f), count: meta?.counts[item.id] ?? 0, total: meta?.total ?? 0 },
            allowComments: meta?.allowComments ?? false,
        });
    }
    return views;
}

export function postsFeedHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const group = getGroup(event);
        const archives = await listArchives(group.path, 'published');
        const newest = archives[archives.length - 1];
        return respond(event, format, {
            space: group,
            title: group.name,
            description: group.topic,
            url: f => postsFeedUrl(config, group, f),
            // The newest archive overlaps the current feed, so the first complete archive is the one before.
            prevArchiveUrl: newest > 1 ? f => archiveFeedUrl(config, group, newest - 1, f) : undefined,
            items: await postViews(group, await readLog(group.path, 'published')),
        });
    };
}

export async function archiveFeedHandler(_log: LogContext, event: IncomingHttpRequest) {
    const config = getConfig();
    const group = getGroup(event);
    const { n, format } = checkArchiveFile(event.pathParameters.file, 'archive');
    if (!(await listArchives(group.path, 'published')).includes(n))
        throw new NotFoundError('Unknown archive');
    return respond(event, format, {
        space: group,
        title: `${group.name} (archive ${n})`,
        description: group.topic,
        url: f => archiveFeedUrl(config, group, n, f),
        prevArchiveUrl: n > 1 ? f => archiveFeedUrl(config, group, n - 1, f) : undefined,
        isArchive: true,
        items: await postViews(group, await readLog(group.path, 'published', n)),
    });
}

const SHOW_VALUES = ['all', 'comments', 'mentions'] as const;
type Show = typeof SHOW_VALUES[number];

// Renders the direct replies to a post or comment. `external` is the post's guid in the feed of a
// feedComments space; `meta` is undefined for posts of a feed before their first reply.
async function repliesFeed(event: IncomingHttpRequest, format: FeedFormat, space: SpaceConfig, postGuid: string, parentGuid: string,
                           meta: PostMeta | undefined, show: Show, external?: string): Promise<RawResponse> {
    const config = getConfig();
    let parent: StoredItem | undefined;
    if (parentGuid != postGuid) parent = await findComment(space.path, parentGuid);
    else if (space.type == 'group') parent = await findPublishedPost(space.path, postGuid);
    if (!parent && (parentGuid != postGuid || space.type == 'group')) throw new NotFoundError(parentGuid == postGuid ? 'Unknown post' : 'Unknown comment');

    const what = parent?.title ? `"${parent.title}"` : parentGuid == postGuid ? 'a post' : 'a comment';
    const inReplyTo = (f: FeedFormat) => parentGuid == postGuid && external !== undefined
        ? feedPostRef(space, external, f)
        : itemUrl(config, space, parentGuid, f, external);
    const comments = meta && show != 'mentions' ? await readComments(space.path, parentGuid) : [];
    const mentions = meta && show != 'comments' && parentGuid == postGuid && space.type == 'feed' ? await readMentions(space.path, postGuid) : [];
    const items: ItemView[] = [
        ...comments.map(item => ({
            item,
            inReplyTo,
            comments: { feedUrl: (f: FeedFormat) => commentsFeedUrl(config, space, item.id, f), count: meta!.counts[item.id] ?? 0 },
        })),
        ...mentions.map(item => ({ item, inReplyTo, mention: true })),
    ].sort((a, b) => a.item.date_published.localeCompare(b.item.date_published));
    const query = show == 'all' ? '' : `?show=${show}`;
    return respond(event, format, {
        space,
        title: `${space.name}: ${show == 'mentions' ? 'mentions of' : 'replies to'} ${what}`,
        description: space.topic,
        url: f => commentsFeedUrl(config, space, parentGuid, f, external) + query,
        items,
    });
}

// GET /groups/:group/comments/:post/comments.(json|xml) and /groups/:group/comments/:post/:parent/comments.(json|xml).
export function commentsFeedHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const group = getGroup(event);
        const postGuid = checkPostGuid(event.pathParameters.post, 'post');
        const parentGuid = event.pathParameters.parent === undefined ? postGuid : checkCommentOfPost(event.pathParameters.parent, postGuid, 'parent');
        const meta = await readPostMeta(group.path, postGuid);
        if (!meta) throw new NotFoundError('Unknown post');
        return repliesFeed(event, format, group, postGuid, parentGuid, meta, 'comments');
    };
}

function getFeedSpace(event: IncomingHttpRequest): SpaceConfig {
    const space = getSpace(event);
    if (space.type != 'feed') throw new NotFoundError('Unknown feed');
    return space;
}

// GET /comments/:feed/post/<guid>.(json|xml)[?show=all|comments|mentions]: the comments and mentions of a
// post of the feed, by the post's own guid. An empty feed before the first reply.
export async function feedPostRepliesHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = getFeedSpace(event);
    const show = checkEnum(event.queryStringParameters.show, 'show', SHOW_VALUES, 'all');
    const { base, format } = checkFeedFile(event.pathParameters.file, 'feed');
    const external = checkExternalGuid(base, 'post');
    const postGuid = externalPostGuid(space.id, external);
    const meta = await readPostMeta(space.path, postGuid);
    return repliesFeed(event, format, space, postGuid, postGuid, meta, show, external);
}

// GET /comments/:feed/comment/<comment guid>.(json|xml): the replies to a comment.
export async function feedCommentRepliesHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = getFeedSpace(event);
    const { base, format } = checkFeedFile(event.pathParameters.file, 'feed');
    const guid = checkCommentGuid(base, 'comment');
    const postGuid = postGuidOf(guid);
    const meta = await readPostMeta(space.path, postGuid);
    if (!meta) throw new NotFoundError('Unknown comment');
    return repliesFeed(event, format, space, postGuid, guid, meta, 'comments', meta.external);
}

// GET /groups/:group/submissions.(json|xml) and /comments/:feed/submissions.(json|xml): the submissions
// element alone, for feeds to include.
export function submissionsHandler(format: FeedFormat) {
    return async (_log: LogContext, event: IncomingHttpRequest) => {
        const config = getConfig();
        const space = getSpace(event);
        return format == 'json'
            ? { _submissions: submissionsJson(config, space) }
            : new RawResponse(renderSubmissionsXml(config, space), 'application/xml; charset=utf-8');
    };
}
