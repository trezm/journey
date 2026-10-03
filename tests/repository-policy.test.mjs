import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryPolicy, updatePolicy, approvalAuthority, hasApproval, validateIntegrationAuthority, approvalInbox, emit, publicState } from '../lib/avc/core.ts';
const owner = { id:'owner', agent:false }, coordinator = { id:'agent:coordinator', agent:true, role:'coordinator' }, worker = { id:'agent:worker', agent:true, role:'worker' };
function fixture() {
    const j = { id:'j',title:'Feature',actor:worker.id,actorRole:'worker',status:'review',head:'revision',base:'main',reconciledHead:'main',reconciledCursor:0,changesets:[{id:'c',description:'Complete feature',patches:[{id:'p'}]}],manifest:[],manifestDeclared:true,reviews:[],dispositions:{},created:0 };
    const s = { id:'repo',name:'Repository',head:'main',requireApproval:true,journeys:[j],leases:[],events:[],sequence:0,integrationCursor:0 };
    return {s,j};
}
const fails = (fn, code) => assert.throws(fn, e => e.code === code);
test('legacy settings keep worker merging and human approval; policy writes validate all fields before changing state', () => {
    const {s} = fixture();
    assert.deepEqual(repositoryPolicy(s), {requireApproval:true,allowWorkerMerge:true,allowCoordinatorApproval:false});
    assert.equal(publicState(s,worker.id,true).allowWorkerMerge,true);
    fails(() => updatePolicy(s,{allowWorkerMerge:false,allowCoordinatorApproval:'true'},owner),'invalid_policy');
    assert.equal(s.allowWorkerMerge,undefined);
    for (const user of [worker,coordinator]) fails(() => updatePolicy(s,{allowCoordinatorApproval:true},user),'forbidden');
    fails(() => updatePolicy(s,{},owner),'invalid_policy');
    updatePolicy(s,{requireApproval:false},owner);
    assert.deepEqual(repositoryPolicy(s),{requireApproval:false,allowWorkerMerge:true,allowCoordinatorApproval:false});
});
test('coordinator approval is opt-in, for other workers only; approval authority comes from authenticated role', () => {
    const {s,j} = fixture();
    assert.equal(approvalAuthority(s,j,owner),'human');
    fails(() => approvalAuthority(s,j,coordinator),'coordinator_approval_disabled');
    updatePolicy(s,{allowCoordinatorApproval:true},owner);
    fails(() => approvalAuthority(s,j,worker),'human_approval_required');
    fails(() => approvalAuthority(s,j,{...worker,role:undefined}),'human_approval_required');
    assert.equal(approvalAuthority(s,j,coordinator),'coordinator');
    fails(() => approvalAuthority(s,{...j,actor:coordinator.id},coordinator),'self_approval_denied');
    for (const author of [{actor:'owner',actorRole:'human'},{actor:'agent:other-coordinator',actorRole:'coordinator'}]) fails(() => approvalAuthority(s,{...j,...author},coordinator),'worker_journey_required');
    delete j.actorRole;
    fails(() => approvalAuthority(s,j,coordinator),'worker_journey_required');
    assert.equal(approvalAuthority(s,j,coordinator,{[worker.id]:'worker'}),'coordinator');
    fails(() => approvalAuthority(s,j,coordinator,{[worker.id]:'coordinator'}),'worker_journey_required');
});
test('disabled worker merging blocks agents while owner can merge; required approval and exact revision still apply', () => {
    const {s,j} = fixture();
    fails(() => validateIntegrationAuthority(s,j,worker),'approval_required');
    j.reviews.push({kind:'approve',revision:'old',authority:'human'});
    assert.equal(hasApproval(s,j),false);
    j.reviews.push({kind:'approve',revision:j.head}); // Pre-feature approvals were human.
    validateIntegrationAuthority(s,j,worker);
    updatePolicy(s,{allowWorkerMerge:false},owner);
    for (const user of [worker,coordinator]) fails(() => validateIntegrationAuthority(s,j,user),'worker_merge_disabled');
    validateIntegrationAuthority(s,j,owner);
});
test('coordinator revocation cancels existing approvals permanently without invalidating human approval', () => {
    const {s,j} = fixture();
    updatePolicy(s,{allowCoordinatorApproval:true},owner);
    const review = {kind:'approve',revision:j.head,authority:'coordinator'};
    j.reviews.push(review); assert.equal(hasApproval(s,j),true);
    updatePolicy(s,{allowCoordinatorApproval:false},owner);
    assert.equal(review.resolved,true); assert.equal(hasApproval(s,j),false);
    updatePolicy(s,{allowCoordinatorApproval:true},owner); assert.equal(hasApproval(s,j),false);
    j.reviews.push({kind:'approve',revision:j.head,authority:'human'});
    updatePolicy(s,{allowCoordinatorApproval:false},owner); assert.equal(hasApproval(s,j),true);
});
test('coordinator queue works without own journey, excludes own/non-worker journeys and never exposes leases', () => {
    const {s,j} = fixture();
    s.leases.push({journey:j.id,token:'private-worker-lease'});
    s.journeys.push({...structuredClone(j),id:'own',actor:coordinator.id,actorRole:'coordinator'}, {...structuredClone(j),id:'human',actor:owner.id,actorRole:'human'}, {...structuredClone(j),id:'other-coordinator',actor:'agent:other',actorRole:'coordinator'});
    fails(() => approvalInbox(s,worker),'forbidden');
    let inbox = approvalInbox(s,coordinator);
    assert.equal(inbox.queue.length,1); assert.equal(inbox.ready.length,0); assert(inbox.queue[0].reasons.includes('coordinator_approval_disabled'));
    updatePolicy(s,{allowCoordinatorApproval:true},owner);
    inbox = approvalInbox(s,coordinator);
    assert.equal(inbox.ready.length,1); assert.equal(inbox.ready[0].revision,j.head); assert(!JSON.stringify(inbox).includes('private-worker-lease'));
    assert.equal(approvalInbox(s,owner).queue.length,4);
});
test('legacy approval queues require a known repository worker role and preserve explicit historical roles', () => {
    const {s,j} = fixture(); updatePolicy(s,{allowCoordinatorApproval:true},owner);
    delete j.actorRole;
    assert.equal(approvalInbox(s,coordinator).queue.length,0);
    assert.equal(approvalInbox(s,coordinator,0,{[worker.id]:'worker'}).ready.length,1);
    assert.equal(approvalInbox(s,coordinator,0,{[worker.id]:'coordinator'}).queue.length,0);
    j.actorRole='coordinator';
    assert.equal(approvalInbox(s,coordinator,0,{[worker.id]:'worker'}).queue.length,0);
    j.actorRole='worker';
    assert.equal(approvalInbox(s,coordinator).ready.length,1);
});
test('readiness responds to stale main, changes requested, old approvals, declarations, and policy notifications', () => {
    const {s,j} = fixture(); updatePolicy(s,{allowCoordinatorApproval:true},owner);
    assert.equal(approvalInbox(s,coordinator).ready.length,1);
    s.head='changed-main'; s.integrationCursor=3;
    let inbox=approvalInbox(s,coordinator); assert.equal(inbox.queue[0].reviewable,false); assert(inbox.queue[0].reasons.includes('reconciliation_required'));
    j.reconciledHead=s.head; j.reconciledCursor=s.integrationCursor;
    j.reviews.push({kind:'request_changes',resolved:false,revision:j.head});
    assert(approvalInbox(s,coordinator).queue[0].reasons.includes('changes_requested'));
    j.reviews[0].resolved=true;
    j.reviews.push({kind:'approve',revision:'old',authority:'human'}); assert.equal(approvalInbox(s,coordinator).ready.length,1);
    j.reviews.push({kind:'approve',revision:j.head,authority:'coordinator'}); assert.equal(approvalInbox(s,coordinator).ready.length,0);
    j.manifestDeclared=false; assert(approvalInbox(s,coordinator).queue[0].reasons.includes('manifest_required'));
    emit(s,'lock.granted',worker.id,{id:'private'},j.id,[j.id]);
    const submitted=emit(s,'review.requested',worker.id,{revision:j.head},j.id,[j.id]);
    const policy=emit(s,'policy.changed',owner.id,repositoryPolicy(s));
    inbox=approvalInbox(s,coordinator,submitted.id-1);
    assert.deepEqual(inbox.events.map(e=>e.id),[submitted.id,policy.id]);
    assert.equal(approvalInbox(s,coordinator,inbox.cursor).events.length,0);
    fails(()=>approvalInbox(s,coordinator,NaN),'invalid_cursor');
});
