import { randomInt } from 'crypto';

// Post guids are 10 base62 characters (~59 bits). Comment guids append one 5-character base36
// segment per nesting level: <post-guid>-<seg> for replies to posts, <parent-guid>-<seg> for replies
// to comments. Segments only need to be unique among the siblings, so they are short; collisions
// are checked by the caller.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export const POST_GUID_LENGTH = 10;
export const SEGMENT_LENGTH = 5;

const POST_GUID_RE = /^[0-9A-Za-z]{10}$/;
const SEGMENT_RE = /^[0-9a-z]{5}$/;

function randomString(alphabet: string, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++)
        s += alphabet[randomInt(alphabet.length)];
    return s;
}

export function newPostGuid(): string {
    return randomString(BASE62, POST_GUID_LENGTH);
}

export function newCommentGuid(parentGuid: string): string {
    return parentGuid + '-' + randomString(BASE36, SEGMENT_LENGTH);
}

export function isValidGuid(guid: string): boolean {
    if (typeof guid != 'string') return false;
    const [post, ...segments] = guid.split('-');
    return POST_GUID_RE.test(post) && segments.every(s => SEGMENT_RE.test(s));
}

export function isPostGuid(guid: string): boolean {
    return POST_GUID_RE.test(guid);
}

export function postGuidOf(guid: string): string {
    return guid.split('-')[0];
}

// The guid of the item a comment replies to (a post or a comment). Undefined for posts.
export function parentGuidOf(guid: string): string | undefined {
    const i = guid.lastIndexOf('-');
    return i < 0 ? undefined : guid.substring(0, i);
}

// 0 for posts, 1 for replies to posts, 2 for replies to those, ...
export function depthOf(guid: string): number {
    return guid.split('-').length - 1;
}

// True if `guid` is `ancestor` itself or one of its descendants.
export function isSelfOrDescendant(guid: string, ancestor: string): boolean {
    return guid == ancestor || guid.startsWith(ancestor + '-');
}
