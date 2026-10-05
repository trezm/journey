export type LiveResourceState<T> = {
    key: string;
    data?: T;
    loading: boolean;
    running: boolean;
    error: string;
    receivedAt?: number;
};
type Scheduler = {
    later: (callback: () => void, delay: number) => unknown;
    cancel: (handle: unknown) => void;
    now: () => number;
};
const scheduler: Scheduler = {
    later: (callback, delay) => setTimeout(callback, delay),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
};

/** Poll after completion, retaining the last good snapshot on a transient failure. */
export class LiveResource<T> {
    private state: LiveResourceState<T> = { key: '', loading: false, running: false, error: '' };
    private generation = 0;
    private controller?: AbortController;
    private pending?: Promise<void>;
    private timer?: unknown;
    private fetchData: (key: string, signal: AbortSignal) => Promise<T>;
    private notify: (state: LiveResourceState<T>) => void;
    private clock: Scheduler;
    private interval: number;

    constructor(fetchData: (key: string, signal: AbortSignal) => Promise<T>, notify: (state: LiveResourceState<T>) => void, clock = scheduler, interval = 4000) {
        this.fetchData = fetchData;
        this.notify = notify;
        this.clock = clock;
        this.interval = interval;
    }
    private update(update: Partial<LiveResourceState<T>>) {
        this.state = { ...this.state, ...update };
        this.notify(this.state);
    }
    private cancel() {
        this.generation++;
        this.controller?.abort();
        this.controller = undefined;
        this.pending = undefined;
        this.clock.cancel(this.timer);
        this.timer = undefined;
    }
    select(key: string) {
        this.cancel();
        this.update({ key, data: undefined, loading: false, error: '', receivedAt: undefined });
        if (this.state.running) void this.refresh();
    }
    setRunning(running: boolean) {
        if (running === this.state.running) return;
        this.cancel();
        this.update({ running, loading: false });
        if (running) void this.refresh();
    }
    refresh(key = this.state.key): Promise<void> {
        if (!key || key !== this.state.key) return Promise.resolve();
        if (this.pending) return this.pending;
        this.clock.cancel(this.timer);
        this.timer = undefined;
        const generation = ++this.generation;
        const controller = new AbortController();
        this.controller = controller;
        this.update({ loading: true });
        const pending = Promise.resolve().then(() => this.fetchData(key, controller.signal)).then(data => {
            if (generation === this.generation) this.update({ data, receivedAt: this.clock.now(), error: '' });
        }).catch(error => {
            if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : 'Unable to refresh the live map.' });
        }).finally(() => {
            if (generation !== this.generation) return;
            this.pending = undefined;
            this.controller = undefined;
            this.update({ loading: false });
            if (this.state.running) this.timer = this.clock.later(() => void this.refresh(), this.interval);
        });
        this.pending = pending;
        return pending;
    }
}
