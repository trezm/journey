export const REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
    constructor() {
        super('The request timed out. It may still finish; refresh the workspace to check its status.');
        this.name = 'RequestTimeoutError';
    }
}

export class JsonResponseError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'JsonResponseError';
        this.status = status;
        this.code = code;
    }
}

export async function jsonFetch(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const abort = () => controller.abort(init?.signal?.reason);
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            // Reject independently of fetch so a stalled response body also has a deadline.
            reject(new RequestTimeoutError());
            controller.abort();
        }, timeoutMs);
    });
    try {
        return await Promise.race([
            (async () => {
                const response = await fetch(url, { ...init, signal: controller.signal });
                // Callers consume the different response shapes returned by the workspace endpoints.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const data = await response.json() as any;
                if (!response.ok) throw new JsonResponseError(data.error ?? 'Request failed', response.status, data.code);
                return data;
            })(),
            timeout,
        ]);
    } finally {
        clearTimeout(timer);
        init?.signal?.removeEventListener('abort', abort);
    }
}

export class PendingIntegrationRequests {
    private pending = new Map<string, string>();

    body(project: string, journey: string, data: Record<string, unknown>) {
        const key = JSON.stringify([project, journey]);
        let body = this.pending.get(key);
        if (!body) {
            body = JSON.stringify({ action: 'integrate', project, journey, requestId: crypto.randomUUID(), ...data });
            this.pending.set(key, body);
        }
        // An uncertain integration must replay identical bytes, even if polling changed the head or leases.
        return body;
    }

    settle(project: string, journey: string) {
        this.pending.delete(JSON.stringify([project, journey]));
    }
}
