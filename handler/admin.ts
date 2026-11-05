// Admin functions of a group, authenticated with "Authorization: Bearer <adminToken>".
import { getConfig, GroupConfig } from '../lib/config';
import { MAX_TITLE_LENGTH, textToHtml } from '../lib/content';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { isPostGuid, isValidGuid, parentGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { publishItem } from '../lib/processor';
import { authenticateBearer, IncomingHttpRequest, time } from '../lib/server-common';
import { setStatus } from '../lib/status';
import {
    deleteCommentTree, deletePost, findComment, findInLog, findPublishedPost, listArchives, LogKind, readComments, readLog,
    readPostMeta, StoredItem, updateComment, updatePublishedPost, withGroupLock, writePostMeta,
} from '../lib/storage';
import { itemUrl } from '../lib/urls';
import { getGroup } from './mention';

export const MAX_REPLACEMENT_LENGTH = 10000;

function authenticate(event: IncomingHttpRequest): GroupConfig {
    const group = getGroup(event.pathParameters.group);
    authenticateBearer(event, group.adminToken);
    return group;
}

function guidParam(event: IncomingHttpRequest): string {
    const guid = event.pathParameters.guid;
    if (!isValidGuid(guid)) throw new InvalidRequestError('Invalid guid');
    return guid;
}

async function findPublished(group: GroupConfig, guid: string): Promise<StoredItem | undefined> {
    return parentGuidOf(guid) ? findComment(group.id, guid) : findPublishedPost(group.id, guid);
}

// GET /groups/:group/admin/:log?archive=<n> with log = submissions | failed | published
export async function listLogHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const kind = event.pathParameters.log as LogKind;
    if (!['submissions', 'failed', 'published'].includes(kind)) throw new NotFoundError('Unknown log');
    const archiveParam = event.queryStringParameters.archive;
    const archive = archiveParam === undefined ? undefined : Number(archiveParam);
    if (archive !== undefined && !(Number.isInteger(archive) && archive > 0)) throw new InvalidRequestError('Invalid archive');
    return {
        items: await readLog(group.id, kind, archive),
        archives: await listArchives(group.id, kind),
    };
}

// GET /groups/:group/admin/items/:guid — the published item with internal data, post metadata and failed replies.
export async function getItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const guid = guidParam(event);
    const item = await findPublished(group, guid);
    if (!item) throw new NotFoundError('Item not found');
    return {
        item,
        ...(isPostGuid(guid) ? { post: await readPostMeta(group.id, guid) } : {}),
        failedReplies: await readComments(group.id, guid, 'failed'),
    };
}

// PUT /groups/:group/admin/posts/:guid/commenting {allowComments: boolean}
export async function setCommentingHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const guid = guidParam(event);
    if (!isPostGuid(guid)) throw new InvalidRequestError('Commenting can only be set for posts');
    const allowComments = event.body?.allowComments;
    if (typeof allowComments != 'boolean') throw new InvalidRequestError('allowComments must be a boolean');
    return withGroupLock(group.id, async () => {
        const meta = await readPostMeta(group.id, guid);
        if (!meta) throw new NotFoundError('Post not found');
        meta.allowComments = allowComments;
        await writePostMeta(group.id, meta);
        return { guid, allowComments };
    });
}

// PUT /groups/:group/admin/items/:guid {title?: string, text: string} — replaces a post or comment, author "Admin".
export async function replaceItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const guid = guidParam(event);
    const { title, text } = event.body ?? {};
    if (typeof text != 'string' || !text.trim() || text.length > MAX_REPLACEMENT_LENGTH)
        throw new InvalidRequestError('text must be a non-empty string');
    if (title !== undefined && (typeof title != 'string' || title.length > MAX_TITLE_LENGTH))
        throw new InvalidRequestError('title must be a string');
    const replace = (old: StoredItem): StoredItem => {
        const { title: _t, ...rest } = old;
        return {
            ...rest,
            ...(title?.trim() ? { title: title.trim() } : {}),
            content_html: textToHtml(text),
            authors: [{ name: 'Admin' }],
            date_modified: time.now().toISOString(),
            _source: { about: old._source?.about ?? '' },
            _rssmention: { ...old._rssmention, replacedByAdmin: true },
        };
    };
    const updated = await withGroupLock(group.id, () =>
        parentGuidOf(guid) ? updateComment(group.id, guid, replace) : updatePublishedPost(group.id, guid, replace));
    if (!updated) throw new NotFoundError('Item not found');
    return { guid, replaced: true };
}

// DELETE /groups/:group/admin/items/:guid — deletes a post or comment with all replies.
export async function deleteItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const guid = guidParam(event);
    return withGroupLock(group.id, async () => {
        if (!(await findPublished(group, guid))) throw new NotFoundError('Item not found');
        if (parentGuidOf(guid))
            return { guid, deleted: await deleteCommentTree(group.id, guid) };
        const meta = await readPostMeta(group.id, guid);
        await deletePost(group.id, guid);
        return { guid, deleted: 1 + (meta?.total ?? 0) };
    });
}

// POST /groups/:group/admin/items/:guid/approve — publishes a submission that failed moderation.
export async function approveItemHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = authenticate(event);
    const guid = guidParam(event);
    const parent = parentGuidOf(guid);
    const failed = parent
        ? (await readComments(group.id, parent, 'failed')).find(i => i.id == guid)
        : await findInLog(group.id, 'failed', guid);
    if (!failed) throw new NotFoundError('Failed submission not found');
    if (!failed._rssmention.failure?.code.startsWith('moderation-'))
        throw new InvalidRequestError('Only submissions that failed moderation can be approved');
    const { failure: _f, ...internal } = failed._rssmention;
    const item: StoredItem = { ...failed, _rssmention: { ...internal, approved: true } };
    const published = await withGroupLock(group.id, () => publishItem(group, item));
    if ('failure' in published) throw new InvalidRequestError(published.failure.text);
    const pubUrl = itemUrl(getConfig(), group.id, guid, 'json');
    setStatus(group.id, guid, { status: 'success', pubDate: published.pubDate, pubUrl });
    return { guid, status: 'success', pubDate: published.pubDate, pubUrl };
}
