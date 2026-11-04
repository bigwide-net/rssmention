import { buildModerationPrompt, isOkAnswer, moderate, moderationDeps } from '../lib/moderation';
import { testConfig } from './helpers';

function answer(content: string, status = 200) {
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));
}

describe('moderation', () => {
    const originalFetch = moderationDeps.fetch;
    const { config, cleanup } = testConfig({ submissionRules: { moderationLLM: 'openai/gpt-6-luna' } });
    const group = config.groups.twowaves;
    afterAll(cleanup);
    beforeEach(() => { process.env.OPENROUTER_API_KEY = 'key'; });
    afterEach(() => {
        moderationDeps.fetch = originalFetch;
        delete process.env.OPENROUTER_API_KEY;
    });

    it('builds the prompt without expanding placeholders in the comment', () => {
        const prompt = buildModerationPrompt({ ...group, moderationPrompt: 'Topic "{topic}":\n{comment}' }, 'evil {topic} $& text');
        expect(prompt).toBe('Topic "Discussions about RSS":\nevil {topic} $& text');
    });

    it('recognizes ok answers', () => {
        for (const a of ['ok', 'OK', ' Ok. ', '"ok"', '**ok**'])
            expect(isOkAnswer(a)).toBe(true);
        for (const a of ['okay, but', 'not ok', 'This is spam.'])
            expect(isOkAnswer(a)).toBe(false);
    });

    it('accepts on ok', async () => {
        let request: any;
        moderationDeps.fetch = (url, init) => { request = { url, init }; return answer('ok'); };
        expect(await moderate(group, 'hello')).toEqual({ ok: true });
        expect(request.url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(request.init.headers.Authorization).toBe('Bearer key');
        expect(JSON.parse(request.init.body)).toMatchObject({ model: 'openai/gpt-6-luna', messages: [{ role: 'user', content: expect.stringContaining('hello') }] });
    });

    it('rejects with the reason', async () => {
        moderationDeps.fetch = () => answer('This is spam.');
        expect(await moderate(group, 'buy now')).toEqual({ ok: false, code: 'moderation-rejected', text: 'This is spam.' });
    });

    it('retries once on errors', async () => {
        let calls = 0;
        moderationDeps.fetch = () => ++calls == 1 ? answer('', 500) : answer('ok');
        expect(await moderate(group, 'x')).toEqual({ ok: true });
        expect(calls).toBe(2);
    });

    it('fails after the second error', async () => {
        let calls = 0;
        moderationDeps.fetch = () => { calls++; return Promise.reject(new Error('network down')); };
        expect(await moderate(group, 'x')).toEqual({ ok: false, code: 'moderation-unavailable', text: 'Moderation failed: network down' });
        expect(calls).toBe(2);
    });

    it('fails closed without API key', async () => {
        delete process.env.OPENROUTER_API_KEY;
        expect(await moderate(group, 'x')).toMatchObject({ ok: false, code: 'moderation-unavailable' });
    });

    it('is skipped without a configured model', async () => {
        moderationDeps.fetch = () => { throw new Error('must not be called'); };
        expect(await moderate({ ...group, moderationLLM: undefined }, 'x')).toEqual({ ok: true });
    });
});
