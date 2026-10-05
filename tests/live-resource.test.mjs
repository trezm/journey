import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveResource } from '../lib/live-resource.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
    const calls = [], states = [], timers = new Map();
    let now = 100, timerId = 0;
    const resource = new LiveResource((key, signal) => new Promise((resolve, reject) => calls.push({ key, signal, resolve, reject })), state => states.push(state), {
        later(callback, delay) { assert.equal(delay, 4000); timers.set(++timerId, callback); return timerId; },
        cancel(id) { timers.delete(id); }, now: () => now++,
    });
    const fire = () => { const entry = timers.entries().next().value; assert.ok(entry, 'a poll is scheduled'); timers.delete(entry[0]); entry[1](); };
    return { resource, calls, timers, states, latest: () => states.at(-1), fire };
}

test('polling waits for completion and manual refresh shares the in-flight request', async () => {
    const { resource, calls, timers, latest, fire } = fixture();
    resource.select('A'); resource.setRunning(true); await tick();
    assert.equal(calls.length, 1); assert.equal(timers.size, 0);
    const first = resource.refresh(), second = resource.refresh();
    assert.equal(first, second); await tick(); assert.equal(calls.length, 1);
    calls[0].resolve({ sequence: 1 }); await first;
    assert.equal(latest().loading, false); assert.equal(latest().receivedAt, 100); assert.equal(timers.size, 1);
    fire(); await tick(); assert.equal(calls.length, 2); assert.equal(timers.size, 0);
    resource.setRunning(false); calls[1].resolve({ sequence: 2 }); await tick();
    assert.equal(latest().data.sequence, 1); assert.equal(timers.size, 0);
});

test('pause or hidden document aborts pending work, and manual refresh still works while paused', async () => {
    const { resource, calls, timers, latest } = fixture();
    resource.select('repo'); resource.setRunning(true); await tick();
    calls[0].resolve({ sequence: 1 }); await tick();
    resource.setRunning(false); assert.equal(timers.size, 0); assert.equal(latest().data.sequence, 1);
    const manual = resource.refresh(); await tick(); assert.equal(calls.length, 2);
    calls[1].resolve({ sequence: 2 }); await manual;
    assert.equal(latest().running, false); assert.equal(timers.size, 0);
    resource.setRunning(true); await tick(); assert.equal(calls.length, 3);
    resource.setRunning(false); assert.equal(calls[2].signal.aborted, true);
    calls[2].reject(new Error('late error')); await tick();
    assert.equal(latest().error, ''); assert.equal(latest().data.sequence, 2);
    resource.setRunning(true); await tick(); assert.equal(calls.length, 4);
    resource.setRunning(false);
});

test('switching repository rejects old successes, failures, and stale refresh handlers', async () => {
    const { resource, calls, latest, timers } = fixture();
    resource.select('A'); resource.setRunning(true); await tick();
    resource.select('B'); await tick();
    assert.equal(calls[0].signal.aborted, true); assert.equal(latest().data, undefined);
    calls[1].resolve({ project: 'B' }); await tick();
    calls[0].resolve({ project: 'A' }); await tick();
    assert.equal(latest().data.project, 'B');
    await resource.refresh('A'); assert.equal(calls.length, 2);
    const request = resource.refresh(); await tick();
    resource.select(''); resource.setRunning(false);
    assert.equal(calls[2].signal.aborted, true); assert.equal(latest().data, undefined);
    calls[2].reject(new Error('late failure')); await request;
    assert.equal(latest().key, ''); assert.equal(latest().error, ''); assert.equal(timers.size, 0);
});

test('a transient failure keeps the last good map and automatically retries', async () => {
    const { resource, calls, latest, fire } = fixture();
    resource.select('A'); resource.setRunning(true); await tick();
    calls[0].resolve({ sequence: 7 }); await tick();
    const stamp = latest().receivedAt;
    fire(); await tick(); calls[1].reject(new Error('Network unavailable')); await tick();
    assert.equal(latest().data.sequence, 7); assert.equal(latest().receivedAt, stamp); assert.equal(latest().error, 'Network unavailable');
    fire(); await tick(); calls[2].resolve({ sequence: 8 }); await tick();
    assert.equal(latest().data.sequence, 8); assert.equal(latest().error, ''); assert.ok(latest().receivedAt > stamp);
    resource.setRunning(false);
});
