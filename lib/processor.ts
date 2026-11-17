// Asynchronous processing of accepted webmentions: fetch the source, validate, moderate, publish.
import { getConfig, SpaceConfig, SubmissionRules } from './config';
import { decodeEntities, escapeHtml, MAX_TITLE_LENGTH, MAX_URL_LENGTH, processContent, processTitle } from './content';
import { FeedParseError, findSourceItem, parseFeed, SourceFeed, SourceItem } from './feed-parse';
import { fetchFeed } from './fetch';
import { depthOf, isPostGuid, parentGuidOf, postGuidOf } from './ids';
import { log as rootLog } from './log';
import { moderate } from './moderation';
import { cleanLine, httpUrl, MAX_FAILED_CONTENT_LENGTH, MAX_FAILURE_TEXT_LENGTH, MAX_NAME_LENGTH, quote, truncate } from './sanitize';
import { time } from './server-common';
import { setStatus } from './status';
import {
    addFailedComment, addFailedMention, addPublishedComment, addPublishedMention, appendToLog, deleteCommentTree, deleteMention, deletePost,
    findComment, readPostMeta, setSource, SOURCE_ABOUT, StoredItem, updateComment, updateMention, updatePublishedPost, withGroupLock, writePostMeta,
} from './storage';
import { encodeGuid, itemUrl, normalizeFeedRef } from './urls';

// A submitted item's pubDate is republished if it is at most this far from the submission time.
export const PUBDATE_TOLERANCE_MS = 30 * 60 * 1000;
// Pages of a paged feed (next_url, atom:link rel="next") that are searched for an item, including the first.
export const MAX_FEED_PAGES = 10;
// Mentions are not limited by the configuration; this only keeps the mentions file of a post bounded.
export const MAX_MENTIONS_PER_POST = 1000;
// Characters of a mention's text that are given to the moderation.
const MENTION_MODERATION_TEXT = 2000;

export interface Submission {
    space: SpaceConfig;
    guid: string;
    source: string;
    target: string;
    // true if the source was submitted before: the published item is updated or deleted
    update: boolean;
    // for updates: the published item is a mention
    mention?: boolean;
}

export interface Failure {
    code: string;
    text: string;
}

export const processorDeps = { fetchFeed, moderate };

const log = rootLog.sub('processor');

export function rulesFor(space: SpaceConfig, guid: string): SubmissionRules {
    return parentGuidOf(guid) ? space.comments : space.posts;
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

type PageSearch = { item: SourceItem } | { item?: undefined, complete: boolean };

/**
 * Searches a paged feed for an item, starting with the already fetched first page. Follows next links
 * on the same host, never a page twice, at most MAX_FEED_PAGES pages. `complete` is false if the
 * search gave up before the end of the chain (which must never be taken as a delete).
 */
export async function searchPages(firstUrl: string, first: SourceFeed, match: (feed: SourceFeed) => SourceItem | undefined): Promise<PageSearch> {
    const start = new URL(firstUrl);
    start.hash = '';
    const seen = new Set([start.href]);
    let feed = first, base = start.href;
    for (let pages = 1; ; pages++) {
        const item = match(feed);
        if (item) return { item };
        if (!feed.next) return { complete: true };
        if (pages >= MAX_FEED_PAGES) return { complete: false };
        let next: URL;
        try {
            next = new URL(feed.next, base);
        } catch {
            return { complete: false };
        }
        next.hash = '';
        if ((next.protocol != 'http:' && next.protocol != 'https:') || next.hostname != start.hostname || seen.has(next.href))
            return { complete: false };
        seen.add(next.href);
        base = next.href;
        try {
            const res = await processorDeps.fetchFeed(next.href);
            if (res.status < 200 || res.status >= 300) return { complete: false };
            feed = parseFeed(res.body);
        } catch {
            return { complete: false };
        }
    }
}

// Validates the source item as a comment against the target and the rules. Returns the item to publish.
export function buildItem(space: SpaceConfig, sub: Submission, src: SourceItem, submittedAt: Date): { item: StoredItem, failure?: Failure } {
    const rules = rulesFor(space, sub.guid);
    const kind = kindOf(sub.guid);
    // The link is optional: one that isn't an absolute http(s) URL of sensible length is dropped.
    const url = httpUrl(src.url, MAX_URL_LENGTH);
    const item: StoredItem = {
        id: sub.guid,
        ...(url ? { url } : {}),
        ...(src.title ? { title: src.title } : {}),
        content_html: src.html ?? '',
        date_published: choosePubDate(src.pubDate, submittedAt).toISOString(),
        authors: [{ name: cleanLine(src.authorName ?? '', MAX_NAME_LENGTH) || 'Anonymous' }],
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
    if (normalizeFeedRef(src.inReplyTo, space) != normalizeFeedRef(sub.target, space))
        return failed('in-reply-to-mismatch', `inReplyTo (${quote(src.inReplyTo)}) does not match the target (${quote(sub.target)})`);

    const title = processTitle(src.title, rules.title, kind);
    if (!title.ok) return failed(title.code, title.text);

    const social = verifySocialSpec(src.socialSpec, sub.source);
    if (rules.requireSocialSpec && social.failure == 'missing')
        return failed('socialspec-missing', 'A socialspec account (source:account service="socialspec") is required');
    if (rules.requireSocialSpec && social.failure == 'mismatch')
        return failed('socialspec-mismatch', `The socialspec account ${quote(src.socialSpec)} must have the host name of the source feed (${new URL(sub.source).hostname})`);
    if (social.account) item._source!.accounts = { socialspec: social.account };

    const content = processContent({ markdown: src.markdown, html: src.html, text: src.text }, rules, kind);
    if (!content.ok) return failed(content.code, content.text);
    item.content_html = content.html;
    if (title.title) item.title = title.title;
    else delete item.title;
    return { item };
}

// The post a mention refers to: its guid in the feed and its link, as stored in the post metadata.
export interface MentionedPost {
    external: string;
    url?: string;
}

// True if the text contains the URL (as link or plain text). HTML entities are decoded first.
function containsUrl(haystack: string, url: string): boolean {
    return haystack.includes(url) || haystack.includes(encodeURI(url));
}

/**
 * Validates the source item as a mention of a post: it must have a link to itself on the source's host,
 * and reference the post with inReplyTo or by containing the post's URL. Mentions are republished as a
 * link only (republish: link): title, link, author and date, no content.
 */
export function buildMention(space: SpaceConfig, sub: Submission, src: SourceItem, submittedAt: Date, post: MentionedPost): { item: StoredItem, failure?: Failure } {
    const title = cleanLine(src.title ?? '', MAX_TITLE_LENGTH) || undefined;
    const url = httpUrl(src.url, MAX_URL_LENGTH);
    const item: StoredItem = {
        id: sub.guid,
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        content_html: '',
        date_published: choosePubDate(src.pubDate, submittedAt).toISOString(),
        authors: [{ name: cleanLine(src.authorName ?? '', MAX_NAME_LENGTH) || 'Anonymous' }],
        _source: { about: SOURCE_ABOUT },
        _rssmention: {
            kind: 'mention',
            source: sub.source,
            target: sub.target,
            submittedAt: submittedAt.toISOString(),
            ...(sub.update ? { edit: true } : {}),
        },
    };
    const failed = (code: string, text: string) => ({ item, failure: { code, text } });

    if (!src.url)
        return failed('link-missing', 'A mention must have a link to the mentioning post (link / url)');
    let link: URL;
    try {
        link = new URL(src.url);
    } catch {
        return failed('invalid-url', 'The link of the mention is not a valid URL');
    }
    if (link.protocol != 'http:' && link.protocol != 'https:')
        return failed('invalid-url', 'The link of the mention must be a http(s) URL');
    if (src.url.length > MAX_URL_LENGTH)
        return failed('url-too-long', `The link of the mention exceeds ${MAX_URL_LENGTH} characters`);
    if (link.hostname.toLowerCase() != new URL(sub.source).hostname.toLowerCase())
        return failed('link-mismatch', `The link of the mention must be on the host of the source feed (${new URL(sub.source).hostname})`);

    const repliesTo = src.inReplyTo && normalizeFeedRef(src.inReplyTo, space) == normalizeFeedRef(sub.target, space);
    if (!repliesTo) {
        const haystack = [src.html ? decodeEntities(src.html) : '', src.markdown ?? '', src.text ?? ''].join('\n');
        const refs = [...(post.url ? [post.url] : []), ...space.feeds!.flatMap(f => [`${f}#${post.external}`, `${f}#${encodeGuid(post.external)}`])];
        if (!refs.some(ref => containsUrl(haystack, ref)))
            return failed('mention-missing', `The item neither replies to the post (inReplyTo) nor links to it${post.url ? ` (${post.url})` : ''}`);
    }

    const social = verifySocialSpec(src.socialSpec, sub.source);
    if (social.account) item._source!.accounts = { socialspec: social.account };
    item.content_html = `<p><a href="${escapeHtml(url!)}">${escapeHtml(title ?? url!)}</a></p>`;
    return { item };
}

// The text of a mention for moderation: title and the beginning of the text, without markup.
function mentionModerationText(item: StoredItem, src: SourceItem): string {
    const text = src.markdown ?? src.text ?? decodeEntities((src.html ?? '').replace(/<[^>]*>/g, ' '));
    return [item.title, item.url, text.replace(/\s+/g, ' ').trim().substring(0, MENTION_MODERATION_TEXT)].filter(Boolean).join('\n\n');
}

/**
 * Finds a post of a feedComments space in its feed (following pagination). The feeds are tried in order
 * until one can be read. Returns the post's feed item, or a failure if it does not exist or is closed.
 */
export async function checkFeedPost(space: SpaceConfig, externalGuid: string): Promise<{ item: SourceItem } | { failure: Failure }> {
    let lastProblem = 'The feed could not be read';
    for (const feedUrl of space.feeds ?? []) {
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
        const found = await searchPages(feedUrl, feed, f => f.items.find(i => i.guid == externalGuid));
        if (!found.item) {
            if (!found.complete) return { failure: { code: 'target-unavailable', text: 'The target post could not be found in the feed or its first pages' } };
            return { failure: { code: 'target-gone', text: 'The target post does not exist in its feed' } };
        }
        if (found.item.allowComments === false) return { failure: { code: 'comments-disabled', text: 'Comments are disabled for this post' } };
        return { item: found.item };
    }
    return { failure: { code: 'target-unavailable', text: lastProblem } };
}

// Checks whether a new comment may still be added (the post or comment may have changed since acceptance).
export async function checkCommentAllowed(space: SpaceConfig, parentGuid: string): Promise<Failure | undefined> {
    if (!space.acceptComments) return { code: 'comments-disabled', text: 'This feed does not accept comments' };
    const meta = await readPostMeta(space.path, postGuidOf(parentGuid));
    if (!meta) return { code: 'target-gone', text: 'The post does not exist (anymore)' };
    if (parentGuid != meta.guid && !(await findComment(space.path, parentGuid)))
        return { code: 'target-gone', text: 'The comment does not exist (anymore)' };
    if (!meta.allowComments) return { code: 'comments-disabled', text: 'Comments are disabled for this post' };
    if (depthOf(parentGuid) + 1 > space.comments.maxDepth)
        return { code: 'max-depth', text: `Comments can be nested at most ${space.comments.maxDepth} levels deep` };
    if (meta.total >= space.posts.commentLimit)
        return { code: 'comment-limit', text: `The post has reached its limit of ${space.posts.commentLimit} comments` };
    if (parentGuid != meta.guid && (meta.counts[parentGuid] ?? 0) >= space.comments.commentLimit)
        return { code: 'comment-limit', text: `The comment has reached its limit of ${space.comments.commentLimit} replies` };
    return undefined;
}

// Checks whether a new mention of the post may still be added.
export async function checkMentionAllowed(space: SpaceConfig, postGuid: string): Promise<Failure | undefined> {
    if (!space.acceptMentions) return { code: 'mentions-disabled', text: 'This feed does not accept mentions' };
    const meta = await readPostMeta(space.path, postGuid);
    if (!meta) return { code: 'target-gone', text: 'The post does not exist (anymore)' };
    if (!meta.allowComments) return { code: 'comments-disabled', text: 'Comments and mentions are disabled for this post' };
    if ((meta.mentions ?? 0) >= MAX_MENTIONS_PER_POST)
        return { code: 'mention-limit', text: `The post has reached its limit of ${MAX_MENTIONS_PER_POST} mentions` };
    return undefined;
}

// What is kept of a failed submission. Items that failed validation may contain anything the source
// sent (up to the feed size limit), so their content is cut. Items that failed moderation passed
// validation and are kept complete, because the admin may approve and publish them.
function boundFailedItem(item: StoredItem, failure: Failure): StoredItem {
    if (failure.code.startsWith('moderation-')) return item;
    const { _source, ...rest } = item;
    return {
        ...rest,
        ...(item.title !== undefined ? { title: truncate(item.title, MAX_TITLE_LENGTH) } : {}),
        content_html: truncate(item.content_html, MAX_FAILED_CONTENT_LENGTH),
        ...(_source ? { _source: { ..._source, ...(_source.markdown !== undefined ? { markdown: truncate(_source.markdown, MAX_FAILED_CONTENT_LENGTH) } : {}) } } : {}),
    };
}

async function recordFailure(space: SpaceConfig, item: StoredItem, fullFailure: Failure): Promise<void> {
    const failure = { code: fullFailure.code, text: truncate(fullFailure.text, MAX_FAILURE_TEXT_LENGTH) };
    setStatus(space.path, item.id, { status: 'failure', ...failure });
    const failed = { ...boundFailedItem(item, failure), _rssmention: { ...item._rssmention, failure } };
    await withGroupLock(space.path, async () => {
        const parent = parentGuidOf(item.id);
        if (item._rssmention.kind == 'mention') await addFailedMention(space.path, failed);
        else if (parent) await addFailedComment(space.path, parent, failed);
        else await appendToLog(space.path, 'failed', failed);
    });
}

/**
 * Publishes a validated item: adds a new post, comment or mention, or replaces the published version.
 * Must be called inside withGroupLock. Returns the publication date, or a failure if the target is gone or full.
 */
export async function publishItem(space: SpaceConfig, item: StoredItem): Promise<{ failure: Failure } | { pubDate: string }> {
    const parent = parentGuidOf(item.id);
    const now = time.now().toISOString();
    let pubDate = item.date_published;
    const replace = (old: StoredItem) => {
        pubDate = old.date_published;
        return { ...item, date_published: old.date_published, date_modified: now };
    };
    if (item._rssmention.kind == 'mention') {
        const replaced = await updateMention(space.path, item.id, replace);
        if (!replaced) {
            if (item._rssmention.edit) return { failure: { code: 'target-gone', text: 'The mention has been deleted' } };
            const failure = await checkMentionAllowed(space, postGuidOf(item.id));
            if (failure) return { failure };
            await addPublishedMention(space.path, item);
        }
    } else if (!parent) {
        const replaced = await updatePublishedPost(space.path, item.id, replace);
        if (!replaced) {
            if (item._rssmention.edit) return { failure: { code: 'target-gone', text: 'The post has been deleted' } };
            const archive = await appendToLog(space.path, 'published', item);
            await writePostMeta(space.path, { guid: item.id, archive, allowComments: item._rssmention.allowComments ?? true, counts: {}, total: 0 });
        }
    } else {
        const replaced = await updateComment(space.path, item.id, replace);
        if (!replaced) {
            if (item._rssmention.edit) return { failure: { code: 'target-gone', text: 'The comment has been deleted' } };
            const failure = await checkCommentAllowed(space, parent);
            if (failure) return { failure };
            await addPublishedComment(space.path, item);
        }
    }
    await setSource(space.path, new URL(item._rssmention.source).href, item.id);
    return { pubDate };
}

// The public URL of a published item: its feed plus #guid.
export async function publishedItemUrl(space: SpaceConfig, guid: string): Promise<string> {
    const external = space.type == 'feed' ? (await readPostMeta(space.path, postGuidOf(guid)))?.external : undefined;
    return itemUrl(getConfig(), space, guid, 'json', external);
}

async function deleteItem(space: SpaceConfig, guid: string, mention: boolean): Promise<void> {
    await withGroupLock(space.path, async () => {
        if (mention) await deleteMention(space.path, guid);
        else if (parentGuidOf(guid)) await deleteCommentTree(space.path, guid);
        else await deletePost(space.path, guid);
    });
    setStatus(space.path, guid, { status: 'deleted' });
}

/**
 * Decides whether a new reply is published as comment or as mention, and validates it. A reply to a
 * post of a feed that accepts mentions becomes a mention if it does not qualify as a comment. If it
 * qualifies as neither, the comment's failure is reported if the item has inReplyTo (it was meant as
 * a comment), the mention's otherwise.
 */
async function classify(space: SpaceConfig, sub: Submission, src: SourceItem, submittedAt: Date): Promise<{ item: StoredItem, failure?: Failure }> {
    const parent = parentGuidOf(sub.guid);
    const mentionPossible = space.acceptMentions && !!parent && isPostGuid(parent);
    if (!sub.mention && (sub.update || !mentionPossible)) return buildItem(space, sub, src, submittedAt);
    const meta = await readPostMeta(space.path, parent!);
    const mention = () => buildMention(space, sub, src, submittedAt, { external: meta?.external ?? '', url: meta?.externalUrl });
    if (sub.mention) return mention();
    const comment = space.acceptComments ? buildItem(space, sub, src, submittedAt) : undefined;
    if (comment && !comment.failure) return comment;
    const m = mention();
    if (!m.failure || !comment || !src.inReplyTo) return m;
    return comment;
}

export async function processSubmission(sub: Submission): Promise<void> {
    const space = sub.space;
    const rules = rulesFor(space, sub.guid);
    // Mentions can always be updated and deleted, like webmentions in general.
    const mayDelete = sub.mention || rules.allowDelete;
    const mayEdit = sub.mention || rules.allowEdit;
    const submittedAt = time.now();
    const placeholder: StoredItem = {
        id: sub.guid, content_html: '', date_published: submittedAt.toISOString(),
        _rssmention: {
            kind: sub.mention ? 'mention' : parentGuidOf(sub.guid) ? 'comment' : 'post',
            source: sub.source, target: sub.target, submittedAt: submittedAt.toISOString(), ...(sub.update ? { edit: true } : {}),
        },
    };
    const fail = (failure: Failure, item = placeholder) => recordFailure(space, item, failure);
    log.info('Processing {0} from {1}', sub.guid, sub.source);

    let res;
    try {
        res = await processorDeps.fetchFeed(sub.source);
    } catch (err: any) {
        return fail({ code: 'fetch-failed', text: err.message });
    }
    if ((res.status == 404 || res.status == 410) && sub.update && mayDelete)
        return deleteItem(space, sub.guid, !!sub.mention);
    if (res.status < 200 || res.status >= 300)
        return fail({ code: 'fetch-failed', text: `The source returned HTTP ${res.status}` });

    let feed;
    try {
        feed = parseFeed(res.body);
    } catch (err: any) {
        if (err instanceof FeedParseError) return fail({ code: 'invalid-feed', text: err.message });
        throw err;
    }
    const fragment = fragmentOf(sub.source);
    const first = findSourceItem(feed, fragment);
    if (first == 'ambiguous')
        return fail({ code: 'ambiguous-source', text: 'The source feed has more than one item; add #guid to the source URL' });
    const found = first ? { item: first } : fragment ? await searchPages(sub.source, feed, f => f.items.find(i => i.guid == fragment)) : { complete: true };
    const src = found.item;
    if (!src) {
        if (sub.update && mayDelete && 'complete' in found && found.complete) return deleteItem(space, sub.guid, !!sub.mention);
        return fail({ code: 'item-not-found', text: 'The item was not found in the source feed' });
    }
    if (sub.update && !mayEdit)
        return fail({ code: 'edit-not-allowed', text: 'Editing is not allowed in this group' });

    const { item, failure } = await classify(space, sub, src, submittedAt);
    if (failure) {
        // A mention that no longer refers to the post is withdrawn.
        if (sub.mention && failure.code == 'mention-missing') return deleteItem(space, sub.guid, true);
        return fail(failure, item);
    }

    if (!parentGuidOf(sub.guid))
        await withGroupLock(space.path, () => appendToLog(space.path, 'submissions', item));

    const isMention = item._rssmention.kind == 'mention';
    const moderationText = isMention ? mentionModerationText(item, src) : [item.title, src.markdown ?? item.content_html].filter(Boolean).join('\n\n');
    const moderation = await processorDeps.moderate(space, moderationText);
    if (!moderation.ok) return fail({ code: moderation.code, text: moderation.text }, item);

    const published = await withGroupLock(space.path, () => publishItem(space, item));
    if ('failure' in published) return fail(published.failure, item);
    setStatus(space.path, sub.guid, {
        status: 'success', pubDate: published.pubDate, pubUrl: await publishedItemUrl(space, sub.guid), ...(isMention ? { kind: 'mention' } : {}),
    });
    log.info('Published {0}{1}', sub.guid, isMention ? ' (mention)' : '');
}
