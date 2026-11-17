// In-memory status of submissions, keyed by space path and guid. Entries are kept for at least an hour
// after their last change and are lost on restart.
import { time } from './server-common';

export type SubmissionStatus =
    | { status: 'waiting' }
    | { status: 'success', pubDate: string, pubUrl?: string, kind?: 'mention' }
    | { status: 'deleted' }
    | { status: 'failure', code: string, text: string };

export const STATUS_TTL_MS = 60 * 60 * 1000;
export const STATUS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const statuses = new Map<string, { value: SubmissionStatus, updated: number }>();

const key = (space: string, guid: string) => `${space}/${guid}`;

export function setStatus(space: string, guid: string, value: SubmissionStatus): void {
    statuses.set(key(space, guid), { value, updated: time.now().getTime() });
}

export function getStatus(space: string, guid: string): SubmissionStatus | undefined {
    return statuses.get(key(space, guid))?.value;
}

export function cleanupStatuses(): void {
    const limit = time.now().getTime() - STATUS_TTL_MS;
    for (const [k, v] of statuses)
        if (v.updated < limit) statuses.delete(k);
}

export function clearStatuses(): void {
    statuses.clear();
}

export function startStatusCleanup(): NodeJS.Timeout {
    return setInterval(cleanupStatuses, STATUS_CLEANUP_INTERVAL_MS).unref();
}
