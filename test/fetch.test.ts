import http from 'http';
import { AddressInfo } from 'net';
import { checkSourceUrl, fetchFeed, MAX_FEED_BYTES } from '../lib/fetch';

describe('checkSourceUrl()', () => {
    it('accepts http(s) urls with host names', () => {
        expect(checkSourceUrl('https://alice.example/feed.xml#c1')).toBeUndefined();
        expect(checkSourceUrl('http://localhost:8080/feed')).toBeUndefined();
    });

    it('rejects ip addresses, other schemes, credentials and garbage', () => {
        expect(checkSourceUrl('https://127.0.0.1/feed')).toContain('IP address');
        expect(checkSourceUrl('https://93.184.216.34/feed')).toContain('IP address');
        expect(checkSourceUrl('https://[::1]/feed')).toContain('IP address');
        expect(checkSourceUrl('ftp://a.example/feed')).toContain('http(s)');
        expect(checkSourceUrl('https://u:p@a.example/feed')).toContain('credentials');
        expect(checkSourceUrl('feed')).toContain('valid URL');
    });
});

describe('fetchFeed()', () => {
    let server: http.Server;
    let base: string;
    const routes: Record<string, (res: http.ServerResponse) => void> = {
        '/feed': res => res.end('<rss/>'),
        '/redirect': res => { res.writeHead(302, { Location: '/feed' }); res.end(); },
        '/redirect2': res => { res.writeHead(302, { Location: '/redirect' }); res.end(); },
        '/redirect-ip': res => { res.writeHead(302, { Location: 'http://127.0.0.1/feed' }); res.end(); },
        '/huge': res => res.end('x'.repeat(MAX_FEED_BYTES + 10)),
        '/gone': res => { res.writeHead(410); res.end(); },
    };

    beforeAll(async () => {
        server = http.createServer((req, res) => (routes[req.url!] ?? (r => { r.writeHead(404); r.end(); }))(res));
        await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
        base = `http://localhost:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise(r => server.close(r)));
    afterEach(() => { delete process.env.RSSMENTION_ALLOW_PRIVATE_TARGETS; });

    it('refuses private addresses by default', async () => {
        await expect(fetchFeed(`${base}/feed`)).rejects.toThrow(/forbidden address/);
    });

    describe('with private targets allowed', () => {
        beforeEach(() => { process.env.RSSMENTION_ALLOW_PRIVATE_TARGETS = 'true'; });

        it('fetches without the fragment', async () => {
            expect(await fetchFeed(`${base}/feed#item`)).toMatchObject({ status: 200, body: '<rss/>' });
        });

        it('follows one redirect, but not two', async () => {
            expect(await fetchFeed(`${base}/redirect`)).toMatchObject({ status: 200, body: '<rss/>' });
            await expect(fetchFeed(`${base}/redirect2`)).rejects.toThrow('Too many redirects');
        });

        it('refuses redirects to ip addresses', async () => {
            await expect(fetchFeed(`${base}/redirect-ip`)).rejects.toThrow('IP address');
        });

        it('limits the size', async () => {
            await expect(fetchFeed(`${base}/huge`)).rejects.toThrow('exceeds');
        });

        it('returns error statuses', async () => {
            expect((await fetchFeed(`${base}/gone`)).status).toBe(410);
            expect((await fetchFeed(`${base}/nothing`)).status).toBe(404);
        });
    });
});
