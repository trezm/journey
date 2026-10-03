import assert from 'node:assert/strict';
const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
let cookie = '';
async function request(path, body, bearer, expected = 200, session = cookie) {
    const response = await fetch(root + path, { method: body ? 'POST' : 'GET', headers: { ...(bearer ? { Authorization:'Bearer ' + bearer } : { Cookie:session }), ...(body ? { 'Content-Type':'application/json' } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    const data = await response.json();
    assert.equal(response.status,expected,JSON.stringify(data));
    return data.result ?? data;
}
await request('/api/auth',{action:'register',email:'settings-' + crypto.randomUUID() + '@example.com',password:'Settings-test-password-2026'});
const ownerCookie = cookie;
const {project} = await request('/api/avc',{action:'create_project',name:'Repository permissions test',empty:true});
const action = (action, body = {}, bearer, expected = 200) => request('/api/avc',{project,requestId:crypto.randomUUID(),action,...body},bearer,expected);
const state = async bearer => (await request('/api/avc?project=' + project,undefined,bearer)).state;
const inbox = (bearer, since = 0, expected = 200) => request(`/api/avc?project=${project}&approvals=1&since=${since}`,undefined,bearer,expected);
const coordinator = await action('create_agent',{name:'Coordinator',coordinator:true});
const otherCoordinator = await action('create_agent',{name:'Other coordinator',coordinator:true});
const worker = await action('delegate_agent',{name:'Worker'},coordinator.token);
const b = await action('delegate_agent',{name:'Other worker'},coordinator.token);
let s = await state(worker.token);
assert.equal(s.allowWorkerMerge,true); assert.equal(s.allowCoordinatorApproval,false); assert.equal(s.requireApproval,true);
for (const bearer of [worker.token,coordinator.token]) await action('policy',{allowCoordinatorApproval:true},bearer,403);
await action('policy',{allowWorkerMerge:false,allowCoordinatorApproval:'yes'},undefined,400);
assert.equal((await state()).allowWorkerMerge,true);
await inbox(worker.token,0,403);
await inbox(coordinator.token,-1,400);
async function submitted(name, bearer) {
    const {journey} = await action('create_journey',{title:name},bearer);
    const {changeset} = await action('create_changeset',{journey,description:'Complete ' + name},bearer);
    const j = (await state(bearer)).journeys.find(j=>j.id===journey);
    const locks = await action('acquire',{journey,changeset,revision:j.head,scopes:[{path:name + '.txt',start:1,end:1,whole:true}]},bearer);
    const tokens = locks.locks.map(l=>l.token);
    const patch = await action('patch',{journey,changeset,revision:j.head,description:name,edits:[{path:name+'.txt',content:name+'\n'}],tokens},bearer);
    await action('declare_breaking',{journey,changes:[]},bearer);
    await action('submit',{journey,revision:patch.revision,tokens},bearer);
    return {journey,revision:patch.revision,tokens};
}
const a = await submitted('worker-feature',worker.token);
let queue = await inbox(coordinator.token);
assert.equal(queue.canApprove,false); assert.equal(queue.ready.length,0); assert.equal(queue.queue[0].revision,a.revision);
assert(queue.events.some(e=>e.type==='review.requested'&&e.journey===a.journey));
assert(!JSON.stringify(queue).includes(a.tokens[0]));
await action('review',{journey:a.journey,revision:a.revision,kind:'approve'},coordinator.token,403);
await action('policy',{allowCoordinatorApproval:true});
queue = await inbox(coordinator.token,queue.cursor);
assert.equal(queue.ready.length,1); assert(queue.events.some(e=>e.type==='policy.changed'));
await action('review',{journey:a.journey,revision:'outdated',kind:'approve'},coordinator.token,409);
await action('review',{journey:a.journey,revision:a.revision,kind:'approve',authority:'human'},worker.token,403);
await action('review',{journey:a.journey,revision:a.revision,kind:'request_changes',body:'Please check the contract'},coordinator.token);
queue = await inbox(coordinator.token);
assert.equal(queue.ready.length,0); assert(queue.queue[0].reasons.includes('changes_requested'));
await action('review',{journey:a.journey,revision:a.revision,kind:'approve'},coordinator.token,409);
let j = (await state()).journeys.find(j=>j.id===a.journey);
await action('resolve_review',{journey:a.journey,review:j.reviews[0].id},worker.token);
await action('review',{journey:a.journey,revision:a.revision,kind:'approve',authority:'human',body:'Reviewed exact revision'},coordinator.token);
j = (await state()).journeys.find(j=>j.id===a.journey);
assert.equal(j.reviews.at(-1).authority,'coordinator');
assert.equal((await inbox(coordinator.token)).ready.length,0);
// Disabling an opted-in coordinator cancels its previous approvals permanently.
await action('policy',{allowCoordinatorApproval:false});
s = await state(worker.token);
const integrate = () => ({journey:a.journey,revision:a.revision,head:s.head,cursor:s.integrationCursor,tokens:a.tokens});
await action('integrate',integrate(),worker.token,409);
await action('policy',{allowCoordinatorApproval:true});
await action('integrate',integrate(),worker.token,409);
assert.equal((await inbox(coordinator.token)).ready.length,1);
await action('review',{journey:a.journey,revision:a.revision,kind:'approve'},coordinator.token);
await action('policy',{allowWorkerMerge:false});
await action('integrate',integrate(),worker.token,403);
await action('integrate',integrate()); // The owner can still merge with the worker's returned leases.
assert.equal((await state()).journeys.find(j=>j.id===a.journey).status,'integrated');
// Coordinators never approve their own work, other coordinator work, or human-authored work.
const own = await submitted('coordinator-feature',coordinator.token);
await action('review',{journey:own.journey,revision:own.revision,kind:'approve'},coordinator.token,403);
await action('review',{journey:own.journey,revision:own.revision,kind:'approve'},otherCoordinator.token,403);
assert(!(await inbox(coordinator.token)).queue.some(j=>j.journey===own.journey));
const human = await submitted('owner-feature');
await action('review',{journey:human.journey,revision:human.revision,kind:'approve'},coordinator.token,403);
assert(!(await inbox(coordinator.token)).queue.some(j=>j.journey===human.journey));
// New patches remove a candidate from the ready queue; intervening integrations make submitted work stale.
const second = await submitted('second-worker-feature',b.token);
queue = await inbox(coordinator.token);
assert.equal(queue.ready.length,1);
await action('review',{journey:human.journey,revision:human.revision,kind:'approve',authority:'coordinator'});
j = (await state()).journeys.find(j=>j.id===human.journey);
assert.equal(j.reviews.at(-1).authority,'human');
s = await state();
await action('integrate',{...human,head:s.head,cursor:s.integrationCursor});
queue = await inbox(coordinator.token,queue.cursor);
assert.equal(queue.ready.length,0); assert(queue.queue.find(j=>j.journey===second.journey).reasons.includes('reconciliation_required'));
assert(queue.events.some(e=>e.type==='journey.integrated'));
// A different human account cannot change the owner's settings.
await request('/api/auth',{action:'register',email:'other-owner-' + crypto.randomUUID() + '@example.com',password:'Settings-test-password-2026'});
await action('policy',{allowCoordinatorApproval:false},undefined,403);
await request('/api/avc?project=' + project,undefined,undefined,403);
cookie = ownerCookie;
const final = await state();
assert.equal(final.allowWorkerMerge,false); assert.equal(final.allowCoordinatorApproval,true);
await action('policy',{requireApproval:false}); // Legacy policy payload still works and leaves new fields intact.
assert.equal((await state()).allowWorkerMerge,false);
console.log('Repository settings HTTP checks passed: owner-only policy, coordinator opt-in and role/author checks, exact revision, permanent revocation, readiness cursor notifications, worker merge gate, human merge, staleness and legacy policy compatibility.');
