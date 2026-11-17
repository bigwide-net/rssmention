// The webmention endpoint: POST /groups/:group/mention or /comments/:feed/mention with source and target
// (form-encoded or JSON). Synchronous checks reject bad requests with 400; accepted submissions get 201
// with a status page in Location and are processed asynchronously, one at a time.
import { getConfig, SpaceConfig } from '../lib/config';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { checkSourceUrl } from '../lib/fetch';
import { depthOf, newCommentGuid, newPostGuid, parentGuidOf, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { checkCommentAllowed, checkFeedPost, checkMentionAllowed, processSubmission, rulesFor } from '../lib/processor';
import { enqueue } from '../lib/queue';
import { IncomingHttpRequest } from '../lib/server-common';
import { checkGuid, checkUrlParam } from '../lib/params';
import { getStatus, setStatus } from '../lib/status';
import {
    findComment, findMention, findPublishedPost, findSource, postExists, readComments, readMentions, readPostMeta, withGroupLock, writePostMeta,
} from '../lib/storage';
import { normalizeFeedRef, parseTarget, sourceKey, statusUrl, Target } from '../lib/urls';

// Sources that are currently queued or processed, per space: source key -> guid.
const pending = new Map<string, string>();

// The space of a request: path parameter `group` (/groups/:group) or `feed` (/comments/:feed).
export function getSpace(event: IncomingHttpRequest): SpaceConfig {
    const config = getConfig();
    const { group, feed } = event.pathParameters;
    if (group !== undefined) {
        if (!Object.hasOwn(config.groups, group)) throw new NotFoundError('Unknown group');
        return config.groups[group];
    }
    if (feed !== undefined && Object.hasOwn(config.feedComments, feed))
        return config.feedComments[feed];
    throw new NotFoundError('Unknown feed');
}

async function newGuid(space: SpaceConfig, target: Target): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (target.kind == 'group') {
            const guid = newPostGuid();
            if (!(await postExists(space.path, guid)) && !getStatus(space.path, guid)) return guid;
        } else {
            const guid = newCommentGuid(target.guid);
            const taken = (await readComments(space.path, target.guid)).some(i => i.id == guid)
                || (await readComments(space.path, target.guid, 'failed')).some(i => i.id == guid)
                || (target.kind == 'post' && space.acceptMentions && (
                    (await readMentions(space.path, target.guid)).some(i => i.id == guid)
                    || (await readMentions(space.path, target.guid, 'failed')).some(i => i.id == guid)))
                || getStatus(space.path, guid);
            if (!taken) return guid;
        }
    }
    throw new Error('Could not create a unique guid');
}

// Checks that the target exists and accepts a new post, comment or mention. For posts of a
// feedComments space, the feed is fetched to check that the post exists and allows comments; its
// metadata is created on the first reply and its link kept up to date.
async function checkTarget(space: SpaceConfig, target: Target): Promise<void> {
    if (target.kind == 'group') {
        if (!space.acceptPosts)
            throw new InvalidRequestError('This group does not accept new posts');
        return;
    }
    const postGuid = postGuidOf(target.guid);
    const meta = await readPostMeta(space.path, postGuid);
    if (target.kind == 'post' && !target.external && !(await findPublishedPost(space.path, target.guid)))
        throw new InvalidRequestError('The target post does not exist');
    if (target.kind == 'comment' && !(await findComment(space.path, target.guid)))
        throw new InvalidRequestError('The target comment does not exist');
    const external = target.kind == 'post' ? target.external : meta?.external;
    if (external) {
        const result = await checkFeedPost(space, external);
        if ('failure' in result)
            throw new InvalidRequestError(result.failure.text);
        const externalUrl = result.item.url;
        if (!meta || meta.externalUrl != externalUrl)
            await withGroupLock(space.path, async () => {
                const current = await readPostMeta(space.path, postGuid);
                const { externalUrl: _old, ...rest } = current ?? { guid: postGuid, archive: 0, external, allowComments: true, counts: {}, total: 0 };
                await writePostMeta(space.path, { ...rest, ...(externalUrl ? { externalUrl } : {}) });
            });
    }
    // A reply to a post may still become a mention if it doesn't qualify as a comment.
    const commentFailure = await checkCommentAllowed(space, target.guid);
    if (!commentFailure) return;
    if (target.kind == 'post' && space.acceptMentions) {
        const mentionFailure = await checkMentionAllowed(space, target.guid);
        if (!mentionFailure) return;
        if (!space.acceptComments) throw new InvalidRequestError(mentionFailure.text);
    }
    throw new InvalidRequestError(commentFailure.text);
}

export async function mentionHandler(log: LogContext, event: IncomingHttpRequest) {
    const config = getConfig();
    const space = getSpace(event);
    const source = checkUrlParam(event.body?.source, 'source');
    const target = checkUrlParam(event.body?.target, 'target');

    const sourceProblem = checkSourceUrl(source);
    if (sourceProblem)
        throw new InvalidRequestError(sourceProblem);
    if (new URL(source).origin == new URL(config.baseUrl).origin)
        throw new InvalidRequestError('source must not be on this server');
    const parsedTarget = parseTarget(config, space, target);

    const key = `${space.path} ${sourceKey(source)}`;
    if (pending.has(key))
        throw new InvalidRequestError('This source is already being processed');

    let guid: string;
    let mention = false;
    const existing = await findSource(space.path, sourceKey(source));
    if (existing) {
        const mentionItem = parentGuidOf(existing) ? await findMention(space.path, existing) : undefined;
        mention = !!mentionItem;
        const rules = rulesFor(space, existing);
        if (!mention && !rules.allowEdit && !rules.allowDelete)
            throw new InvalidRequestError('This source has already been submitted');
        const published = mentionItem ?? (parentGuidOf(existing) ? await findComment(space.path, existing) : await findPublishedPost(space.path, existing));
        if (published && normalizeFeedRef(published._rssmention.target, space) != normalizeFeedRef(target, space))
            throw new InvalidRequestError('An edited submission must keep its target');
        guid = existing;
    } else {
        await checkTarget(space, parsedTarget);
        guid = await newGuid(space, parsedTarget);
        if (parsedTarget.kind != 'group' && depthOf(guid) > space.comments.maxDepth)
            throw new InvalidRequestError('Maximum comment depth reached');
    }

    pending.set(key, guid);
    setStatus(space.path, guid, { status: 'waiting' });
    try {
        enqueue(async () => {
            try {
                await processSubmission({ space, guid, source, target, update: !!existing, ...(mention ? { mention } : {}) });
            } catch (err) {
                setStatus(space.path, guid, { status: 'failure', code: 'internal', text: 'Internal error while processing the submission' });
                throw err;
            } finally {
                pending.delete(key);
            }
        });
    } catch (err) {
        pending.delete(key);
        setStatus(space.path, guid, { status: 'failure', code: 'queue-full', text: 'Too many pending submissions' });
        throw err;
    }
    log.info('Accepted {0} for {1} as {2}', source, target, guid);

    const location = statusUrl(config, space, guid);
    event.responseStatus = 201;
    event.responseHeaders = { ...event.responseHeaders, Location: location };
    return { status: 'waiting', guid, statusUrl: location };
}

export async function statusHandler(_log: LogContext, event: IncomingHttpRequest) {
    const space = getSpace(event);
    const status = getStatus(space.path, checkGuid(event.pathParameters.guid, 'status'));
    if (!status)
        throw new NotFoundError('Unknown or expired status');
    return status;
}
