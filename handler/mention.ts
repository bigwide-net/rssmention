// The webmention endpoint: POST /groups/:group/mention with source and target (form-encoded or JSON).
// Synchronous checks reject bad requests with 400; accepted submissions get 201 with a status page
// in Location and are processed asynchronously, one at a time.
import { getConfig, GroupConfig } from '../lib/config';
import { InvalidRequestError, NotFoundError } from '../lib/exceptions';
import { checkSourceUrl } from '../lib/fetch';
import { depthOf, newCommentGuid, newPostGuid, parentGuidOf, postGuidOf } from '../lib/ids';
import { LogContext } from '../lib/log';
import { checkCommentAllowed, checkExternalPost, processSubmission, rulesFor } from '../lib/processor';
import { enqueue } from '../lib/queue';
import { IncomingHttpRequest } from '../lib/server-common';
import { getStatus, setStatus } from '../lib/status';
import { findComment, findPublishedPost, findSource, postExists, readComments, readPostMeta, withGroupLock, writePostMeta } from '../lib/storage';
import { normalizeFeedRef, parseTarget, sourceKey, statusUrl, Target } from '../lib/urls';

export const MAX_URL_PARAM_LENGTH = 2048;

// Sources that are currently queued or processed, per group: source key -> guid.
const pending = new Map<string, string>();

export function getGroup(groupId: string | undefined): GroupConfig {
    const group = groupId ? getConfig().groups[groupId] : undefined;
    if (!group || !Object.hasOwn(getConfig().groups, groupId!))
        throw new NotFoundError('Unknown group');
    return group;
}

function stringParam(body: any, name: string): string {
    const value = body?.[name];
    if (typeof value != 'string' || !value.trim())
        throw new InvalidRequestError(`Missing parameter ${name}`);
    if (value.length > MAX_URL_PARAM_LENGTH)
        throw new InvalidRequestError(`Parameter ${name} is too long`);
    return value.trim();
}

async function newGuid(group: GroupConfig, target: Target): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
        if (target.kind == 'group') {
            const guid = newPostGuid();
            if (!(await postExists(group.id, guid)) && !getStatus(group.id, guid)) return guid;
        } else {
            const guid = newCommentGuid(target.guid);
            const taken = (await readComments(group.id, target.guid)).some(i => i.id == guid)
                || (await readComments(group.id, target.guid, 'failed')).some(i => i.id == guid)
                || getStatus(group.id, guid);
            if (!taken) return guid;
        }
    }
    throw new Error('Could not create a unique guid');
}

// Checks that the target exists and accepts a new post or comment. For posts in external feeds, the
// feed is fetched to check that the post exists and allows comments; its metadata is created on the
// first comment.
async function checkTarget(group: GroupConfig, target: Target): Promise<void> {
    if (target.kind == 'group') {
        if (!group.acceptPosts)
            throw new InvalidRequestError('This group does not accept new posts');
        return;
    }
    const postGuid = postGuidOf(target.guid);
    const meta = await readPostMeta(group.id, postGuid);
    if (target.kind == 'post' && !target.external && !(await findPublishedPost(group.id, target.guid)))
        throw new InvalidRequestError('The target post does not exist');
    if (target.kind == 'comment' && !(await findComment(group.id, target.guid)))
        throw new InvalidRequestError('The target comment does not exist');
    const external = target.kind == 'post' ? target.external : meta?.external;
    if (external) {
        const problem = await checkExternalPost(group, external);
        if (problem)
            throw new InvalidRequestError(problem.text);
        if (!meta)
            await withGroupLock(group.id, async () => {
                if (!(await readPostMeta(group.id, postGuid)))
                    await writePostMeta(group.id, { guid: postGuid, archive: 0, external, allowComments: true, counts: {}, total: 0 });
            });
    }
    const failure = await checkCommentAllowed(group, target.guid);
    if (failure)
        throw new InvalidRequestError(failure.text);
}

export async function mentionHandler(log: LogContext, event: IncomingHttpRequest) {
    const config = getConfig();
    const group = getGroup(event.pathParameters.group);
    const source = stringParam(event.body, 'source');
    const target = stringParam(event.body, 'target');

    const sourceProblem = checkSourceUrl(source);
    if (sourceProblem)
        throw new InvalidRequestError(sourceProblem);
    if (new URL(source).origin == new URL(config.baseUrl).origin)
        throw new InvalidRequestError('source must not be on this server');
    const parsedTarget = parseTarget(config, group.id, target);

    const key = `${group.id} ${sourceKey(source)}`;
    if (pending.has(key))
        throw new InvalidRequestError('This source is already being processed');

    let guid: string;
    const existing = await findSource(group.id, sourceKey(source));
    if (existing) {
        const rules = rulesFor(group, existing);
        if ((!rules.allowEdit && !rules.allowDelete))
            throw new InvalidRequestError('This source has already been submitted');
        const published = parentGuidOf(existing) ? await findComment(group.id, existing) : await findPublishedPost(group.id, existing);
        if (published && normalizeFeedRef(published._rssmention.target) != normalizeFeedRef(target))
            throw new InvalidRequestError('An edited submission must keep its target');
        guid = existing;
    } else {
        await checkTarget(group, parsedTarget);
        guid = await newGuid(group, parsedTarget);
        if (parsedTarget.kind != 'group' && depthOf(guid) > group.comments.maxDepth)
            throw new InvalidRequestError('Maximum comment depth reached');
    }

    pending.set(key, guid);
    setStatus(group.id, guid, { status: 'waiting' });
    try {
        enqueue(async () => {
            try {
                await processSubmission({ groupId: group.id, guid, source, target, update: !!existing });
            } catch (err) {
                setStatus(group.id, guid, { status: 'failure', code: 'internal', text: 'Internal error while processing the submission' });
                throw err;
            } finally {
                pending.delete(key);
            }
        });
    } catch (err) {
        pending.delete(key);
        setStatus(group.id, guid, { status: 'failure', code: 'queue-full', text: 'Too many pending submissions' });
        throw err;
    }
    log.info('Accepted {0} for {1} as {2}', source, target, guid);

    const location = statusUrl(config, group.id, guid);
    event.responseStatus = 201;
    event.responseHeaders = { ...event.responseHeaders, Location: location };
    return { status: 'waiting', guid, statusUrl: location };
}

export async function statusHandler(_log: LogContext, event: IncomingHttpRequest) {
    const group = getGroup(event.pathParameters.group);
    const status = getStatus(group.id, event.pathParameters.guid);
    if (!status)
        throw new NotFoundError('Unknown or expired status');
    return status;
}
