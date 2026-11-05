import express from 'express';
import cors from 'cors';
import type QueryString from 'qs'; // type-only (QueryString.ParsedQs) — no runtime require of qs
import { initHappyServer } from '@downread/happy-server';
import { HttpError } from './lib/exceptions';
import { createRateLimitMiddleware, getClientIp } from './lib/limits.middleware';
import { IncomingHttpRequest, RawResponse } from './lib/server-common';
import { log as rootLog, LogContext } from './lib/log';
import { Config, getConfig, setConfig } from './lib/config';
import { startStatusCleanup } from './lib/status';
import { mentionHandler, statusHandler } from './handler/mention';
import { archiveFeedHandler, commentsFeedHandler, postsFeedHandler, submissionsHandler } from './handler/feeds';
import { approveItemHandler, deleteItemHandler, getItemHandler, listLogHandler, replaceItemHandler, setCommentingHandler } from './handler/admin';

function convertHeaders(headers: QueryString.ParsedQs | Record<string, any>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key in headers) {
        const value = headers[key];
        if (value !== undefined)
            result[key] = Array.isArray(value) ? value.join(', ') : (typeof value == 'string' ? value : '<unsupported>');
    }
    return result;
}

export function wrapHandlerExpress(f: (log: LogContext, event: IncomingHttpRequest) => any): express.RequestHandler {
    const headers = {
        'Content-Type': 'application/json',
    };
    return async (req, res) => {
        const log = rootLog.sub('request');
        log.info('request', { method: req.method, path: req.path });
        const event: IncomingHttpRequest = {
            body: req.body,
            queryStringParameters: convertHeaders(req.query),
            headers: convertHeaders(req.headers),
            pathParameters: req.params as Record<string, string>,
            sourceIp: getClientIp(req),
            responseHeaders: {},
        };
        try {
            const responseObject = await f(log, event);
            const status = event.responseStatus ?? 200;
            log.info('Response {0}', status);
            if (responseObject instanceof RawResponse)
                res.set({ ...event.responseHeaders, 'Content-Type': responseObject.contentType }).status(status).send(responseObject.body);
            else
                res.set({ ...headers, ...event.responseHeaders }).status(status).json(responseObject);
        }
        catch (err: any) {
            const status = err.statusCode || 500;
            if (!(err instanceof HttpError))
                log.exception(err);
            else if (status >= 500)
                log.error('{0}: {1}', err.name, err.message);
            else
                log.warning('{0}: {1}', err.name, err.message);
            const body = {
                type: err.name,
                message: (err.statusCode || process.env.DEBUG == 'true') ? err.message : 'Internal error',
                ...((err instanceof HttpError && err.extraData) ? err.extraData : {}),
                ...(process.env.DEBUG == 'true' ? { stack: err.stack } : {}),
            };
            res.set(headers).status(status).json(body);
        }
        finally {
            log.close();
        }
    };
}

export function createApp(options: { happyServer?: boolean } = {}): express.Express {
    const app = express();
    app.set('trust proxy', false);
    // Webmention senders post form-encoded (the spec's format); JSON is accepted as well.
    app.use(express.urlencoded({ extended: false, limit: '16kb' }));
    app.use(express.json({ limit: '64kb' }));
    // Feeds and status pages are public and read by web clients; no credentials are involved.
    app.use(cors({ origin: '*', exposedHeaders: ['Location', 'Link'] }));
    const rateLimiter = createRateLimitMiddleware({ maxPerIpPerMinute: 60 });
    app.use(rateLimiter);
    const finishHappyServerInit = options.happyServer !== false ? initHappyServer(app, { vitals: {} }) : undefined;

    app.get('/', (_req, res) => {
        res.send('rssmention running');
    });

    app.get('/groups/:group/posts.json', wrapHandlerExpress(postsFeedHandler('json')));
    app.get('/groups/:group/posts.xml', wrapHandlerExpress(postsFeedHandler('xml')));
    app.get('/groups/:group/archive/:file', wrapHandlerExpress(archiveFeedHandler));
    app.get('/groups/:group/comments/:post/comments.json', wrapHandlerExpress(commentsFeedHandler('json')));
    app.get('/groups/:group/comments/:post/comments.xml', wrapHandlerExpress(commentsFeedHandler('xml')));
    app.get('/groups/:group/comments/:post/:parent/comments.json', wrapHandlerExpress(commentsFeedHandler('json')));
    app.get('/groups/:group/comments/:post/:parent/comments.xml', wrapHandlerExpress(commentsFeedHandler('xml')));
    app.get('/groups/:group/external/:guid/comments.json', wrapHandlerExpress(commentsFeedHandler('json', { external: true })));
    app.get('/groups/:group/external/:guid/comments.xml', wrapHandlerExpress(commentsFeedHandler('xml', { external: true })));
    app.get('/groups/:group/submissions.json', wrapHandlerExpress(submissionsHandler('json')));
    app.get('/groups/:group/submissions.xml', wrapHandlerExpress(submissionsHandler('xml')));
    app.post('/groups/:group/mention', wrapHandlerExpress(mentionHandler));
    app.get('/groups/:group/status/:guid', wrapHandlerExpress(statusHandler));

    // Admin routes
    app.get('/groups/:group/admin/items/:guid', wrapHandlerExpress(getItemHandler));
    app.put('/groups/:group/admin/items/:guid', wrapHandlerExpress(replaceItemHandler));
    app.delete('/groups/:group/admin/items/:guid', wrapHandlerExpress(deleteItemHandler));
    app.post('/groups/:group/admin/items/:guid/approve', wrapHandlerExpress(approveItemHandler));
    app.put('/groups/:group/admin/posts/:guid/commenting', wrapHandlerExpress(setCommentingHandler));
    app.get('/groups/:group/admin/:log', wrapHandlerExpress(listLogHandler));

    finishHappyServerInit?.();
    return app;
}

export function startController(config: Config) {
    console.log('Starting rssmention');
    setConfig(config);
    startStatusCleanup();
    const app = createApp();
    app.listen(getConfig().port, '0.0.0.0', () => {
        console.log(`rssmention running on http://localhost:${config.port}, public URL ${config.baseUrl}`);
    });
}
