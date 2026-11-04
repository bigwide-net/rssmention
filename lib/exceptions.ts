// Subset of t-lib-backend/server/exceptions.ts (mono repo), plus rssmention-specific errors.

export class HttpError extends Error {
    constructor(public name: string, public statusCode: number, message: string, public extraData?: any) {
        super(message);
    }
}

export class InvalidAuthError extends HttpError {
    constructor(public message: string) {
        super('InvalidAuth', 401, message);
    }
}

export class NotFoundError extends HttpError {
    constructor(public message: string) {
        super('NotFound', 404, message);
    }
}

export class InvalidRequestError extends HttpError {
    constructor(public message: string) {
        super('InvalidRequest', 400, message);
    }
}

export class InternalError extends HttpError {
    constructor(public message: string) {
        super('Internal', 500, message);
    }
}

// The processing queue is full. Webmention senders should retry later.
export class QueueFullError extends HttpError {
    constructor() {
        super('QueueFull', 503, 'Too many pending submissions. Please try again later.');
    }
}
