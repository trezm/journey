#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
const root = process.env.AVC_URL?.replace(/\/$/, ''), project = process.env.AVC_PROJECT, token = process.env.AVC_TOKEN;
if (!root || !project || !token) { process.stderr.write('Set AVC_URL, AVC_PROJECT and AVC_TOKEN. For private Sites, also set AVC_SITE_SERVICE_TOKEN.\n'); process.exit(1); }
const headers = { Authorization: `Bearer ${token}`, ...(process.env.AVC_SITE_SERVICE_TOKEN ? { 'OAI-Sites-Authorization': `Bearer ${process.env.AVC_SITE_SERVICE_TOKEN}` } : {}) };
const [command, ...args] = process.argv.slice(2);
const say = data => console.log(JSON.stringify(data, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(query = {}) { const url = new URL(root + '/api/avc'); url.search = new URLSearchParams({ project, ...query }).toString(); const res = await fetch(url, { headers }); const data = await res.json(); if (!res.ok) throw new Error(data.error); return data; }
async function post(body) {
    const request = { project, requestId: crypto.randomUUID(), ...body }, payload = JSON.stringify(request);
    for (let retry = 0; retry < 3; retry++) {
        try { const res = await fetch(root + '/api/avc', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: payload }); const data = await res.json(); if (res.status >= 500 && retry < 2) continue; if (!res.ok) throw new Error(JSON.stringify(data)); return data.result ?? data; }
        catch (e) { if (retry === 2) throw e; }
    }
}
function approvals(cursor = '0') { const since = Number(cursor); if (!Number.isSafeInteger(since) || since < 0) throw new Error('Supply a nonnegative integer event cursor.'); return get({ approvals: '1', since: String(since) }); }
try {
    if (command === 'state') say(await get());
    else if (command === 'approvals') say(await approvals(args[0]));
    else if (command === 'approve') {
        const [journey, revision, description] = args;
        if (!journey || !/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Usage: approve <journey> <exact-40-character-revision> [description]');
        const inbox = await approvals(), candidate = inbox.queue.find(j => j.journey === journey);
        if (!candidate) throw new Error('Journey is not in your approval queue.');
        if (candidate.revision !== revision) throw new Error('This is not the current exact journey revision. Inspect approvals and review the new revision.');
        if (!inbox.canApprove || !candidate.ready || !candidate.reviewable || candidate.approved) throw new Error(candidate.reasons.join(', ') || 'Journey is not ready for approval.');
        const { user } = await get();
        if (!user || (user.agent && user.role !== 'coordinator')) throw new Error('Only a human or an opted-in repository coordinator can approve.');
        say(await post({ action: 'review', journey, revision, kind: 'approve', authority: user.agent ? 'coordinator' : 'human', body: description ?? 'Approved after review' }));
    } else if (command === 'inbox') say(await get({ journey: args[0], since: args[1] ?? '0' }));
    else if (command === 'poll' || command === 'poll-approvals') {
        let cursor = (command === 'poll' ? args[1] : args[0]) ?? '0', previousQueue;
        for (;;) {
            const data = command === 'poll' ? await get({ journey: args[0], since: cursor }) : await approvals(cursor);
            for (const event of data.events) console.log(JSON.stringify(event));
            if (command === 'poll-approvals') {
                const snapshot = JSON.stringify({ policy: data.policy, canApprove: data.canApprove, head: data.head, integrationCursor: data.integrationCursor, queue: data.queue });
                if (snapshot !== previousQueue) { console.log(JSON.stringify({ type: 'approvals.queue_changed', ...JSON.parse(snapshot), ready: data.queue.filter(j => j.ready).map(j => j.journey) })); previousQueue = snapshot; }
            }
            cursor = String(data.cursor); await sleep(3000);
        }
    } else if (command === 'keepalive') {
        for (;;) { const { state } = await get(); const tokens = state.leases.filter(l => l.journey === args[0] && l.token).map(l => l.token); if (!tokens.length) throw new Error('No current leases remain; reacquire before publishing.'); console.log(JSON.stringify(await post({ action: 'refresh', journey: args[0], tokens }))); await sleep(60000); }
    } else if (command === 'record') { const body = JSON.parse(await readFile(args[1], 'utf8')); say(await post({ ...body, action: 'record', journey: args[0] })); }
    else if (command === 'request') { const body = JSON.parse(await readFile(args[0], 'utf8')); say(await post(body)); }
    else if (command === 'patch') { const [journey, changeset, path, file, description] = args; const { state } = await get(), j = state.journeys.find(j => j.id === journey); if (!j) throw new Error('Journey not found.'); say(await post({ action: 'patch', journey, changeset, revision: j.head, description, edits: [{ path, content: await readFile(file, 'utf8') }], tokens: state.leases.filter(l => l.journey === journey && l.token).map(l => l.token) })); }
    else throw new Error('Commands: record <journey> <json-file> | state | request <json-file> | inbox <journey> [cursor] | poll <journey> [cursor] | approvals [cursor] | poll-approvals [cursor] | approve <journey> <exact-revision> [description] | keepalive <journey> | patch <journey> <changeset> <repo-path> <local-file> <description>');
} catch (e) { process.stderr.write(e.message + '\n'); process.exit(1); }
