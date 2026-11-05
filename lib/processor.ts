// Asynchronous processing of accepted webmentions: fetch the source, validate, moderate, publish.
import { getConfig, GroupConfig, SubmissionRules } from './config';
import { processContent, processTitle } from './content';
import { FeedParseError, findSourceItem, parseFeed, SourceItem } from './feed-parse';
import { fetchFeed } from './fetch';
import { depthOf, parentGuidOf, postGuidOf } from './ids';
import { log as rootLog } from './log';
import { moderate } from './moderation';
import { time } from './server-common';
import { setStatus } from './status';
import {
    addFailedComment, addPublishedComment, appendToLog, deleteCommentTree, deletePost, findComment, readPostMeta,
    setSource, SOURCE_ABOUT, StoredItem, updateComment, updatePublishedPost, withGroupLock, writePostMeta,
} from './storage';
import { itemUrl, normalizeFeedRef } from './urls';

// A submitted item's pubDate is republished if it is at most this far from the submission time.
export const PUBDATE_TOLERANCE_MS = 30 * 60 * 1000;

export interface Submission {
    groupId: string;
    guid: string;
    source: string;
    target: string;
    // true if the source was submitted before: the published item is updated or deleted
    update: boolean;
}

export interface Failure {
    code: string;
    text: string;
}

export const processorDeps = { fetchFeed, moderate };

const log = rootLog.sub('processor');

export function rulesFor(group: GroupConfig, guid: string): SubmissionRules {
    return parentGuidOf(guid) ? group.comments : group.posts;
}

function kindOf(guid: string): 'Post' | 'Comment' {
    return parentGuidOf(guid) ? 'Comment' : 'Post';
}

function fragmentOf(source: string): string | undefined {
    const hash = new URL(source).hash.replace(/^#/, '');
    if (!hash) return undefined;
    try {
        return decodeURIComponent(hash);
    } catch {
        return hash;
    }
}

export function choosePubDate(itemDate: Date | undefined, submittedAt: Date): Date {
    if (itemDate && Math.abs(itemDate.getTime() - submittedAt.getTime()) <= PUBDATE_TOLERANCE_MS) return itemDate;
    return submittedAt;
}

// The socialspec account if it is hosted on the source feed's host (proof that the user wrote it).
export function verifySocialSpec(account: string | undefined, source: string): { account?: string, failure?: 'missing' | 'mismatch' } {
    if (!account) return { failure: 'missing' };
    const host = account.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) return { failure: 'mismatch' };
    return host == new URL(source).hostname.toLowerCase() ? { account: '@' + host } : { failure: 'mismatch' };
}

// Validates the source item against the target and the rules. Returns the item to publish.
export function buildItem(group: GroupConfig, sub: Submission, src: SourceItem, submittedAt: Date): { item: StoredItem, failure?: Failure } {
    const rules = rulesFor(group, sub.guid);
    const kind = kindOf(sub.guid);
    const item: StoredItem = {
        id: sub.guid,
        ...(src.url ? { url: src.url } : {}),
        ...(src.title ? { title: src.title } : {}),
        content_html: src.html ?? '',
        date_published: choosePubDate(src.pubDate, submittedAt).toISOString(),
        authors: [{ name: src.authorName || 'Anonymous' }],
        _source: { about: SOURCE_ABOUT, ...(src.markdown ? { markdown: src.markdown } : {}) },
        _rssmention: {
            kind: parentGuidOf(sub.guid) ? 'comment' : 'post',
            source: sub.source,
            target: sub.target,
            submittedAt: submittedAt.toISOString(),
            ...(sub.update ? { edit: true } : {}),
            ...(src.allowComments !== undefined ? { allowComments: src.allowComments } : {}),
        },
    };
    const failed = (code: string, text: string) => ({ item, failure: { code, text } });

    if (!src.inReplyTo)
        return failed('in-reply-to-missing', `The ${kind.toLowerCase()} has no inReplyTo (source:inReplyTo / _source.inReplyTo)`);
    if (normalizeFeedRef(src.inReplyTo) != normalizeFeedRef(sub.target))
        return failed('in-reply-to-mismatch', `inReplyTo (${src.inReplyTo}) does not match the target (${sub.target})`);

    const title = processTitle(src.title, rules.title, kind);
    if (!title.ok) return failed(title.code, title.text);

    const social = verifySocialSpec(src.socialSpec, sub.source);
    if (rules.requireSocialSpec && social.failure == 'missing')
        return failed('socialspec-missing', 'A socialspec account (source:account service="socialspec") is required');
    if (rules.requireSocialSpec && social.failure == 'mismatch')
        return failed('socialspec-mismatch', `The socialspec account ${src.socialSpec} must have the host name of the source feed (${new URL(sub.source).hostname})`);
    if (social.account) item._source!.accounts = { socialspec: social.account };

    const content = processContent({ markdown: src.markdown, html: src.html, text: src.text }, rules, kind);
    if (!content.ok) return failed(content.code, content.text);
    item.content_html = content.html;
    if (title.title) item.title = title.title;
    else delete item.title;
    return { item };
}

// Checks that a post of an external feed exists and allows comments. The external feeds are tried in
// order until one can be read.
export async function checkExternalPost(group: GroupConfig, externalGuid: string): Promise<Failure | undefined> {
    let lastProblem = 'The feed could not be read';
    for (const feedUrl of group.externalFeeds ?? []) {
        let feed;
        try {
            const res = await processorDeps.fetchFeed(feedUrl);
            if (res.status < 200 || res.status >= 300) {
                lastProblem = `The feed ${feedUrl} returned HTTP ${res.status}`;
                continue;
            }
            feed = parseFeed(res.body);
        } catch (err: any) {
            lastProblem = `The feed ${feedUrl} could not be read: ${err.message}`;
            continue;
        }
        const item = feed.items.find(i => i.guid == externalGuid);
        if (!item) return { code: 'target-gone', text: 'The target post does not exist in its feed' };
        if (item.allowComments === false) return { code: 'comments-disabled', text: 'Comments are disabled for this post' };
        return undefined;
    }
    return { code: 'target-unavailable', text: lastProblem };
}

// Checks whether a new comment may still be added (the post or comment may have changed since acceptance).
export async function checkCommentAllowed(group: GroupConfig, parentGuid: string): Promise<Failure | undefined> {
    const meta = await readPostMeta(group.id, postGuidOf(parentGuid));
    if (!meta) return { code: 'target-gone', text: 'The post does not exist (anymore)' };
    if (parentGuid != meta.guid && !(await findComment(group.id, parentGuid)))
        return { code: 'target-gone', text: 'The comment does not exist (anymore)' };
    if (!meta.allowComments) return { code: 'comments-disabled', text: 'Comments are disabled for this post' };
    if (depthOf(parentGuid) + 1 > group.comments.maxDepth)
        return { code: 'max-depth', text: `Comments can be nested at most ${group.comments.maxDepth} levels deep` };
    if (meta.total >= group.posts.commentLimit)
        return { code: 'comment-limit', text: `The post has reached its limit of ${group.posts.commentLimit} comments` };
    if (parentGuid != meta.guid && (meta.counts[parentGuid] ?? 0) >= group.comments.commentLimit)
        return { code: 'comment-limit', text: `The comment has reached its limit of ${group.comments.commentLimit} replies` };
    return undefined;
}

async function recordFailure(group: GroupConfig, item: StoredItem, failure: Failure): Promise<void> {
    setStatus(group.id, item.id, { status: 'failure', ...failure });
    const failed = { ...item, _rssmention: { ...item._rssmention, failure } };
    await withGroupLock(group.id, async () => {
        const parent = parentGuidOf(item.id);
        if (parent) await addFailedComment(group.id, parent, failed);
        else await appendToLog(group.id, 'failed', failed);
    });
}

/**
 * Publishes a validated item: adds a new post or comment, or replaces the published version.
 * Must be called inside withGroupLock. Returns the publication date, or a failure if the target is gone or full.
 */
export async function publishItem(group: GroupConfig, item: StoredItem): Promise<{ failure: Failure } | { pubDate: string }> {
    const parent = parentGuidOf(item.id);
    const now = time.now().toISOString();
    let pubDate = item.date_published;
    const replace = (old: StoredItem) => {
        pubDate = old.date_published;
        return { ...item, date_published: old.date_published, date_modified: now };
    };
    if (!parent) {
        const replaced = await updatePublishedPost(group.id, item.id, replace);
        if (!replaced) {
            if (item._rssmention.edit) return { failure: { code: 'target-gone', text: 'The post has been deleted' } };
            const archive = await appendToLog(group.id, 'published', item);
            await writePostMeta(group.id, { guid: item.id, archive, allowComments: item._rssmention.allowComments ?? true, counts: {}, total: 0 });
        }
    } else {
        const replaced = await updateComment(group.id, item.id, replace);
        if (!replaced) {
            if (item._rssmention.edit) return { failure: { code: 'target-gone', text: 'The comment has been deleted' } };
            const failure = await checkCommentAllowed(group, parent);
            if (failure) return { failure };
            await addPublishedComment(group.id, item);
        }
    }
    await setSource(group.id, new URL(item._rssmention.source).href, item.id);
    return { pubDate };
}

async function deleteItem(group: GroupConfig, guid: string): Promise<void> {
    await withGroupLock(group.id, async () => {
        if (parentGuidOf(guid)) await deleteCommentTree(group.id, guid);
        else await deletePost(group.id, guid);
    });
    setStatus(group.id, guid, { status: 'deleted' });
}

export async function processSubmission(sub: Submission): Promise<void> {
    const group = getConfig().groups[sub.groupId];
    const rules = rulesFor(group, sub.guid);
    const submittedAt = time.now();
    const placeholder: StoredItem = {
        id: sub.guid, content_html: '', date_published: submittedAt.toISOString(),
        _rssmention: { kind: parentGuidOf(sub.guid) ? 'comment' : 'post', source: sub.source, target: sub.target, submittedAt: submittedAt.toISOString(), ...(sub.update ? { edit: true } : {}) },
    };
    const fail = (failure: Failure, item = placeholder) => recordFailure(group, item, failure);
    log.info('Processing {0} from {1}', sub.guid, sub.source);

    let res;
    try {
        res = await processorDeps.fetchFeed(sub.source);
    } catch (err: any) {
        return fail({ code: 'fetch-failed', text: err.message });
    }
    if ((res.status == 404 || res.status == 410) && sub.update && rules.allowDelete)
        return deleteItem(group, sub.guid);
    if (res.status < 200 || res.status >= 300)
        return fail({ code: 'fetch-failed', text: `The source returned HTTP ${res.status}` });

    let feed;
    try {
        feed = parseFeed(res.body);
    } catch (err: any) {
        if (err instanceof FeedParseError) return fail({ code: 'invalid-feed', text: err.message });
        throw err;
    }
    const src = findSourceItem(feed, fragmentOf(sub.source));
    if (src == 'ambiguous')
        return fail({ code: 'ambiguous-source', text: 'The source feed has more than one item; add #guid to the source URL' });
    if (!src) {
        if (sub.update && rules.allowDelete) return deleteItem(group, sub.guid);
        return fail({ code: 'item-not-found', text: 'The item was not found in the source feed' });
    }
    if (sub.update && !rules.allowEdit)
        return fail({ code: 'edit-not-allowed', text: 'Editing is not allowed in this group' });

    const { item, failure } = buildItem(group, sub, src, submittedAt);
    if (failure) return fail(failure, item);

    if (!parentGuidOf(sub.guid))
        await withGroupLock(group.id, () => appendToLog(group.id, 'submissions', item));

    const moderation = await processorDeps.moderate(group, [item.title, src.markdown ?? item.content_html].filter(Boolean).join('\n\n'));
    if (!moderation.ok) return fail({ code: moderation.code, text: moderation.text }, item);

    const published = await withGroupLock(group.id, () => publishItem(group, item));
    if ('failure' in published) return fail(published.failure, item);
    setStatus(group.id, sub.guid, { status: 'success', pubDate: published.pubDate, pubUrl: itemUrl(getConfig(), group.id, sub.guid, 'json') });
    log.info('Published {0}', sub.guid);
}
