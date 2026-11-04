// A process-wide queue that runs submission jobs one at a time. Jobs are lost on restart.
import { QueueFullError } from './exceptions';
import { log } from './log';

export const MAX_QUEUE_LENGTH = 100;

type Job = () => Promise<void>;

const jobs: Job[] = [];
let running = false;
let idleWaiters: (() => void)[] = [];

export function enqueue(job: Job): void {
    if (jobs.length >= MAX_QUEUE_LENGTH)
        throw new QueueFullError();
    jobs.push(job);
    if (!running) void run();
}

export function queueLength(): number {
    return jobs.length;
}

async function run(): Promise<void> {
    running = true;
    while (jobs.length) {
        const job = jobs.shift()!;
        try {
            await job();
        } catch (err) {
            log.exception(err);
        }
    }
    running = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    waiters.forEach(w => w());
}

// Resolves when the queue is empty and no job runs (for tests).
export function whenIdle(): Promise<void> {
    if (!running && !jobs.length) return Promise.resolve();
    return new Promise(resolve => idleWaiters.push(resolve));
}
