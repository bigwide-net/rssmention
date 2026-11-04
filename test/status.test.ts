import { time } from '../lib/server-common';
import { cleanupStatuses, clearStatuses, getStatus, setStatus, STATUS_TTL_MS } from '../lib/status';

describe('status', () => {
    const originalNow = time.now;
    afterEach(() => {
        time.now = originalNow;
        clearStatuses();
    });

    it('stores statuses per group', () => {
        setStatus('a', 'x', { status: 'waiting' });
        expect(getStatus('a', 'x')).toEqual({ status: 'waiting' });
        expect(getStatus('b', 'x')).toBeUndefined();
    });

    it('removes entries older than an hour', () => {
        let now = 1_000_000;
        time.now = () => new Date(now);
        setStatus('a', 'old', { status: 'waiting' });
        now += STATUS_TTL_MS / 2;
        setStatus('a', 'new', { status: 'waiting' });
        now += STATUS_TTL_MS / 2 + 1;
        cleanupStatuses();
        expect(getStatus('a', 'old')).toBeUndefined();
        expect(getStatus('a', 'new')).toEqual({ status: 'waiting' });
    });
});
