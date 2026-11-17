// Admin functions of a group or feedComments space, authenticated with "Authorization: Bearer <adminToken>".
import { SpaceConfig } from '../lib/config';
import { MAX_TITLE_LENGTH, textToHtml } from '../lib/content';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { externalPostGuid, isPostGuid, parentGuidOf, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { publishedItemUrl, publishItem } from '../lib/processor';
import { authenticateBearer, IncomingHttpRequest, time } from '../lib/server-common';
import { checkBoolean, checkExternalGuid, checkGuid, checkOptionalLine, checkOptionalPositiveInt, checkPathName, checkPostGuid, checkText } from '../lib/params';
import { setStatus } from '../lib/status';
import {
    deleteCommentTree, deleteMention, deletePost, findComment, findInLog, findMention, findPublishedPost, listArchives, LogKind, readComments, readLog,
    readMentions, readPostMeta, StoredItem, updateComment, updatePublishedPost, withGroupLock, writePostMeta,
} from '../lib/storage';
import { getSpace } from './mention';

export const MAX_REPLACEMENT_LENGTH = 10000;

function authenticate(event: IncomingHttpRequest): SpaceConfig {
    const space = getSpace(event);
    authenticateBearer(event, space.adminToken);
    return space;
}

async function findPublished(space: SpaceConfig, guid: string): Promise<StoredItem | undefined> {
    if (!parentGuidOf(guid)) return findPublishedPost(space.path, guid);
    return (await findComment(space.path, guid)) ?? (await findMention(space.path, guid));
}

// GET /groups/:group/admin/:log?archive=<n> with log = submissions | failed | published
export async function listLogHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const kind = checkPathName<LogKind>(event.pathParameters.log, 'log', ['submissions', 'failed', 'published']);
    const archive = checkOptionalPositiveInt(event.queryStringParameters.archive, 'archive');
    return {
        items: await readLog(space.path, kind, archive),
        archives: await listArchives(space.path, kind),
    };
}

// GET /groups/:group/admin/items/:guid — the published item with internal data, post metadata and failed replies.
export async function getItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = checkGuid(event.pathParameters.guid, 'item');
    const item = await findPublished(space, guid);
    if (!item) throw new NotFoundError('Item not found');
    return {
        item,
        ...(isPostGuid(guid) ? { post: await readPostMeta(space.path, guid) } : {}),
        failedReplies: await readComments(space.path, guid, 'failed'),
    };
}

// The post guid of /admin/posts/:guid. For feeds, :guid is the post's own guid in the feed.
function postGuidParam(space: SpaceConfig, event: IncomingHttpRequest): string {
    return space.type == 'feed'
        ? externalPostGuid(space.id, checkExternalGuid(event.pathParameters.guid, 'post'))
        : checkPostGuid(event.pathParameters.guid, 'post');
}

// GET /comments/:feed/admin/posts/:guid — the metadata of a post of the feed (by its own guid), failed
// replies and failed mentions.
export async function getFeedPostHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = postGuidParam(space, event);
    const post = await readPostMeta(space.path, guid);
    if (!post) throw new NotFoundError('Post not found');
    return {
        post,
        failedReplies: await readComments(space.path, guid, 'failed'),
        failedMentions: await readMentions(space.path, guid, 'failed'),
    };
}

// PUT /groups/:group/admin/posts/:guid/commenting {allowComments: boolean}. For feeds, :guid is the
// post's own guid; allowComments: false then closes the post for comments and mentions.
export async function setCommentingHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = postGuidParam(space, event);
    const allowComments = checkBoolean(event.body?.allowComments, 'allowComments');
    return withGroupLock(space.path, async () => {
        const meta = await readPostMeta(space.path, guid);
        if (!meta) throw new NotFoundError('Post not found');
        meta.allowComments = allowComments;
        await writePostMeta(space.path, meta);
        return { guid: meta.external ?? guid, allowComments };
    });
}

// PUT /groups/:group/admin/items/:guid {title?: string, text: string} — replaces a post or comment, author "Admin".
export async function replaceItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = checkGuid(event.pathParameters.guid, 'item');
    const text = checkText(event.body?.text, 'text', MAX_REPLACEMENT_LENGTH);
    const title = checkOptionalLine(event.body?.title, 'title', MAX_TITLE_LENGTH);
    const replace = (old: StoredItem): StoredItem => {
        const { title: _t, ...rest } = old;
        return {
            ...rest,
            ...(title ? { title } : {}),
            content_html: textToHtml(text),
            authors: [{ name: 'Admin' }],
            date_modified: time.now().toISOString(),
            _source: { about: old._source?.about ?? '' },
            _rssmention: { ...old._rssmention, replacedByAdmin: true },
        };
    };
    if (await findMention(space.path, guid)) throw new InvalidRequestError('Mentions cannot be replaced, only deleted');
    const updated = await withGroupLock(space.path, () =>
        parentGuidOf(guid) ? updateComment(space.path, guid, replace) : updatePublishedPost(space.path, guid, replace));
    if (!updated) throw new NotFoundError('Item not found');
    return { guid, replaced: true };
}

// DELETE /groups/:group/admin/items/:guid — deletes a post, comment (with all replies) or mention.
export async function deleteItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = checkGuid(event.pathParameters.guid, 'item');
    return withGroupLock(space.path, async () => {
        const item = await findPublished(space, guid);
        if (!item) throw new NotFoundError('Item not found');
        if (item._rssmention.kind == 'mention')
            return { guid, deleted: await deleteMention(space.path, guid) ? 1 : 0 };
        if (parentGuidOf(guid))
            return { guid, deleted: await deleteCommentTree(space.path, guid) };
        const meta = await readPostMeta(space.path, guid);
        await deletePost(space.path, guid);
        return { guid, deleted: 1 + (meta?.total ?? 0) };
    });
}

// POST /groups/:group/admin/items/:guid/approve — publishes a submission (or mention) that failed moderation.
export async function approveItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = authenticate(event);
    const guid = checkGuid(event.pathParameters.guid, 'item');
    const parent = parentGuidOf(guid);
    const failed = parent
        ? (await readComments(space.path, parent, 'failed')).find(i => i.id == guid)
            ?? (parent == postGuidOf(guid) ? (await readMentions(space.path, parent, 'failed')).find(i => i.id == guid) : undefined)
        : await findInLog(space.path, 'failed', guid);
    if (!failed) throw new NotFoundError('Failed submission not found');
    if (!failed._rssmention.failure?.code.startsWith('moderation-'))
        throw new InvalidRequestError('Only submissions that failed moderation can be approved');
    const { failure: _f, ...internal } = failed._rssmention;
    const item: StoredItem = { ...failed, _rssmention: { ...internal, approved: true } };
    const published = await withGroupLock(space.path, () => publishItem(space, item));
    if ('failure' in published) throw new InvalidRequestError(published.failure.text);
    const pubUrl = await publishedItemUrl(space, guid);
    setStatus(space.path, guid, { status: 'success', pubDate: published.pubDate, pubUrl, ...(item._rssmention.kind == 'mention' ? { kind: 'mention' as const } : {}) });
    return { guid, status: 'success', pubDate: published.pubDate, pubUrl };
}
