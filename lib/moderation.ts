// Moderation through an LLM on OpenRouter (OpenAI-compatible chat completions). The model must
// answer "ok" to accept; anything else is the rejection reason.
import { GroupConfig } from './config';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const MODERATION_TIMEOUT_MS = 60_000;

export type ModerationResult =
    | { ok: true }
    | { ok: false, code: 'moderation-rejected' | 'moderation-unavailable', text: string };

export const moderationDeps = {
    fetch: (url: string, init: RequestInit) => fetch(url, init),
};

export function buildModerationPrompt(group: GroupConfig, comment: string): string {
    // Replace {comment} last, so text in the comment is never treated as a placeholder.
    return group.moderationPrompt.replace(/\{topic\}/g, () => group.topic).replace(/\{comment\}/g, () => comment);
}

export function isOkAnswer(answer: string): boolean {
    return answer.trim().toLowerCase().replace(/^["'`*]+|["'`*.!]+$/g, '') == 'ok';
}

async function ask(model: string, apiKey: string, prompt: string): Promise<string> {
    const res = await moderationDeps.fetch(process.env.OPENROUTER_URL || OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
        signal: AbortSignal.timeout(MODERATION_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new Error(`OpenRouter returned HTTP ${res.status}`);
    const data: any = await res.json();
    const answer = data?.choices?.[0]?.message?.content;
    if (typeof answer != 'string')
        throw new Error('OpenRouter returned no answer');
    return answer;
}

/**
 * Moderates a submission. Without a configured model moderation is skipped. Errors are retried once.
 */
export async function moderate(group: GroupConfig, comment: string): Promise<ModerationResult> {
    if (!group.moderationLLM) return { ok: true };
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey)
        return { ok: false, code: 'moderation-unavailable', text: 'Moderation is not available (no API key configured)' };
    const prompt = buildModerationPrompt(group, comment);
    let lastError: any;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const answer = await ask(group.moderationLLM, apiKey, prompt);
            return isOkAnswer(answer) ? { ok: true } : { ok: false, code: 'moderation-rejected', text: answer.trim().substring(0, 1000) };
        } catch (err) {
            lastError = err;
        }
    }
    return { ok: false, code: 'moderation-unavailable', text: `Moderation failed: ${lastError?.message ?? lastError}` };
}
