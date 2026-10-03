import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationFiles } from '../lib/avc/integration.ts';
import { acquire, finalizeIntegration } from '../lib/avc/core.ts';

const now = 1000;
function fixture() {
    const j = { id: 'worker', title: 'Approved work', actor: 'agent', status: 'review', base: 'base', head: 'published', reconciledHead: 'base', reconciledCursor: 0, changesets: [{ id: 'step', patches: [{}] }], manifest: [], manifestDeclared: true, reviews: [{ id: 'approval', kind: 'approve', revision: 'published' }], dispositions: {}, created: 0 };
    const s = { id: 'repo', head: 'base', integrationCursor: 0, journeys: [j], leases: [], waiting: [], events: [], sequence: 0, generation: 0, receipts: {}, revisions: {}, requireApproval: true };
    return { s, j };
}
const lease = (journey, path, start = 0, end = 1, extra = {}) => ({ id: 'lock', token: 'current', generation: 1, journey, changeset: 'step', revision: 'published', path, start: start + 1, end, canonicalStart: start, canonicalEnd: end, expires: now + 1000, ...extra });
const code = expected => error => error.code === expected;

test('the owner integrates published work without missing, expired, or returned editing tokens', () => {
    for (const leases of [[], [lease('worker', 'file.txt', 0, 1, { expires: now - 1 })], [lease('worker', 'other.txt')]]) {
        const { s, j } = fixture();
        s.leases = leases;
        assert.deepEqual({ ...integrationFiles(s, j, { 'file.txt': 'before' }, { 'file.txt': 'before' }, { 'file.txt': 'after' }, [], true, now) }, { 'file.txt': 'after' });
    }
});

test('worker integration still requires every valid current editing token', () => {
    for (const [leases, tokens, expected] of [[[], [], 'locks_required'], [[lease('worker', 'file.txt')], [], 'invalid_lease'], [[lease('worker', 'file.txt', 0, 1, { expires: now })], ['current'], 'invalid_lease'], [[lease('worker', 'file.txt'), lease('worker', 'other.txt', 0, 1, { token: 'second' })], ['current'], 'invalid_lease']]) {
        const { s, j } = fixture();
        s.leases = leases;
        assert.throws(() => integrationFiles(s, j, { 'file.txt': 'before' }, { 'file.txt': 'before' }, { 'file.txt': 'after' }, tokens, false, now), code(expected));
    }
});

test('workers need whole-file coverage for creation and deletion, including empty files', () => {
    for (const [base, ours] of [[{}, { 'file.txt': '' }], [{ 'file.txt': '' }, {}], [{ 'file.txt': 'before' }, {}]]) {
        const { s, j } = fixture();
        s.leases = [lease('worker', 'file.txt')];
        assert.throws(() => integrationFiles(s, j, base, base, ours, ['current'], false, now), code('whole_file_required'));
        s.leases[0].whole = true;
        assert.deepEqual({ ...integrationFiles(s, j, base, base, ours, ['current'], false, now) }, ours);
    }
});

test('worker final coverage remains tied to canonical ranges after intervening changes', () => {
    const { s, j } = fixture();
    const base = { 'file.txt': 'a\nb\nc' }, canonical = { 'file.txt': 'prefix\na\nb\nc' }, ours = { 'file.txt': 'a\nB\nc' };
    s.leases = [lease('worker', 'file.txt', 1, 2)];
    assert.throws(() => integrationFiles(s, j, canonical, base, ours, ['current'], false, now), code('lock_coverage'));
    s.leases[0].canonicalStart = 2;
    s.leases[0].canonicalEnd = 3;
    assert.equal(integrationFiles(s, j, canonical, base, ours, ['current'], false, now)['file.txt'], 'prefix\na\nB\nc');
});

test('both owners and workers respect other active whole-file reservations before integration', () => {
    for (const owner of [true, false]) {
        const { s, j } = fixture();
        s.leases = [lease('worker', 'file.txt', 0, 3, { whole: true }), lease('other', 'file.txt', 99, 100, { whole: true })];
        assert.throws(() => integrationFiles(s, j, { 'file.txt': 'a\nb\nc' }, { 'file.txt': 'a\nb\nc' }, { 'file.txt': 'A\nb\nc' }, ['current'], owner, now), error => {
            assert.equal(error.code, 'integration_lock_conflict');
            assert.deepEqual(error.details, { path: 'file.txt', journey: 'other', lockId: 'lock' });
            assert.equal(JSON.stringify(error.details).includes('current'), false);
            return true;
        });
    }
});

test('creation or deletion conflicts with any other active lease, even when empty text has no hunks', () => {
    for (const [before, after] of [[{}, { 'file.txt': '' }], [{ 'file.txt': '' }, {}], [{ 'file.txt': 'a\nb\nc' }, {}]]) {
        const { s, j } = fixture();
        s.leases = [lease('other', 'file.txt', 99, 100)];
        assert.throws(() => integrationFiles(s, j, before, before, after, [], true, now), code('integration_lock_conflict'));
    }
});

test('replacement and deletion overlapping another canonical range are rejected', () => {
    for (const content of ['a\nB\nc\nd', 'a\nc\nd']) {
        const { s, j } = fixture();
        s.leases = [lease('other', 'file.txt', 1, 2)];
        assert.throws(() => integrationFiles(s, j, { 'file.txt': 'a\nb\nc\nd' }, { 'file.txt': 'a\nb\nc\nd' }, { 'file.txt': content }, [], true, now), code('integration_lock_conflict'));
    }
});

test('insertions at either boundary or inside another canonical lease are rejected', () => {
    for (const content of ['a\ninserted\nb\nc\nd', 'a\nb\ninserted\nc\nd', 'a\nb\nc\ninserted\nd']) {
        const { s, j } = fixture();
        s.leases = [lease('other', 'file.txt', 1, 3)];
        assert.throws(() => integrationFiles(s, j, { 'file.txt': 'a\nb\nc\nd' }, { 'file.txt': 'a\nb\nc\nd' }, { 'file.txt': content }, [], true, now), code('integration_lock_conflict'));
    }
});

test('adjacent replacements are allowed without widening another reservation', () => {
    for (const content of ['A\nb\nc', 'a\nb\nC']) {
        const { s, j } = fixture();
        s.leases = [lease('other', 'file.txt', 1, 2)];
        assert.equal(integrationFiles(s, j, { 'file.txt': 'a\nb\nc' }, { 'file.txt': 'a\nb\nc' }, { 'file.txt': content }, [], true, now)['file.txt'], content);
    }
});

test('only canonical-to-merged changes are tested against canonical lock coordinates', () => {
    const { s, j } = fixture();
    const base = { 'file.txt': 'a\nb\nc\nd' }, canonical = { 'file.txt': 'prefix\na\nb\nc\nd' }, ours = { 'file.txt': 'a\nb\nC\nd' };
    s.leases = [lease('other', 'file.txt', 3, 4)];
    assert.throws(() => integrationFiles(s, j, canonical, base, ours, [], true, now), code('integration_lock_conflict'));
    s.leases[0].canonicalStart = 2;
    s.leases[0].canonicalEnd = 3;
    assert.equal(integrationFiles(s, j, canonical, base, ours, [], true, now)['file.txt'], 'prefix\na\nb\nC\nd');
});

test('expired, own, unrelated, and unchanged reservations do not block owner integration', () => {
    const { s, j } = fixture();
    const base = { 'file.txt': 'a', 'same.txt': 'unchanged' }, ours = { 'file.txt': 'A', 'same.txt': 'unchanged' };
    s.leases = [lease('worker', 'file.txt', 0, 1, { whole: true }), lease('other', 'file.txt', 0, 1, { expires: now }), lease('other', 'same.txt', 0, 1, { whole: true }), lease('other', 'unrelated.txt', 0, 1, { whole: true })];
    assert.deepEqual({ ...integrationFiles(s, j, base, base, ours, [], true, now) }, ours);
});

test('a disjoint insertion is integrated and remaps the other journey canonical lease', () => {
    const { s, j } = fixture();
    const base = { 'file.txt': 'a\nb\nc\nd' }, ours = { 'file.txt': 'prefix\na\nb\nc\nd' };
    s.leases = [lease('other', 'file.txt', 2, 3)];
    const merged = integrationFiles(s, j, base, base, ours, [], true, now);
    finalizeIntegration(s, j, 'accepted', 'owner', base, merged);
    assert.equal(s.head, 'accepted');
    assert.equal(j.status, 'integrated');
    assert.equal(s.leases[0].canonicalStart, 3);
    assert.equal(s.leases[0].canonicalEnd, 4);
});

test('actual acquisition reservations protect new files until their other journey finishes', () => {
    const { s, j } = fixture();
    const other = { ...j, id: 'other', actor: 'second', changesets: [{ id: 'second-step', patches: [] }] };
    s.journeys.push(other);
    const grant = acquire(s, other, 'second-step', [{ path: 'empty.txt', start: 1, end: 1, whole: true }], 'base', {}, {}, 'second', now);
    assert.equal(grant.queued, false);
    assert.throws(() => integrationFiles(s, j, {}, {}, { 'empty.txt': '' }, [], true, now), code('integration_lock_conflict'));
});

test('merge ambiguity is still rejected and validation cannot mutate repository state', () => {
    const { s, j } = fixture();
    const before = structuredClone(s);
    assert.throws(() => integrationFiles(s, j, { 'file.txt': 'canonical' }, { 'file.txt': 'base' }, { 'file.txt': 'ours' }, [], true, now), code('ambiguous_range'));
    assert.deepEqual(s, before);
});

// Exercise the actual route, authorization, and CAS storage using disposable in-memory bindings.
test('owner route retains all 29 authorization, review, reservation, and idempotent CAS scenarios', async t => {
    const { registerHooks } = await import('node:module');
    const { pathToFileURL, fileURLToPath } = await import('node:url');
    const { createHash } = await import('node:crypto');
    const checkout = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const envModule = 'data:text/javascript,' + encodeURIComponent('export const env = globalThis.__ownerValidationEnvironment;');
    const gitModule = 'data:text/javascript,' + encodeURIComponent('export class GitStore { async files(revision) { return structuredClone(globalThis.__ownerValidationGit.files.get(revision)); } async save(files, parent, description, actor) { return globalThis.__ownerValidationGit.save(files, parent, description, actor); } }');
    const hooks = registerHooks({
      resolve(specifier, context, next) {
        if (specifier === 'cloudflare:workers') return {url: envModule, shortCircuit: true};
        if (specifier === '@/lib/avc/git') return {url: gitModule, shortCircuit: true};
        if (specifier.startsWith('@/')) return next(pathToFileURL(checkout + '/' + specifier.slice(2) + '.ts').href, context);
        return next(specifier, context);
      },
    });
    t.after(() => { hooks.deregister(); delete globalThis.__ownerValidationEnvironment; delete globalThis.__ownerValidationGit; });
    const db = {
      rows: new Map(), agents: new Map(), sessions: new Map(), commits: 0, writes: 0,
      prepare(sql) {
        return { bind(...args) { return {
          async first() {
            if (sql.startsWith('SELECT id,owner,name,version,state FROM projects')) return structuredClone(db.rows.get(args[0]) ?? null);
            if (sql.startsWith('SELECT owner FROM projects')) return db.rows.has(args[0]) ? {owner: db.rows.get(args[0]).owner} : null;
            if (sql.startsWith('SELECT project,name,role FROM agents')) return structuredClone(db.agents.get(args[0]) ?? null);
            if (sql.startsWith('SELECT sessions.user,users.email')) return structuredClone(db.sessions.get(args[0]) ?? null);
            throw Error('Unhandled first query: ' + sql);
          },
          async all() { if (sql.startsWith('SELECT id,name FROM projects')) return {results:[...db.rows.values()].filter(r => r.owner === args[0]).map(r => ({id:r.id,name:r.name}))}; throw Error('Unhandled all query: ' + sql); },
          async run() {
            if (sql.startsWith('INSERT INTO projects')) { db.rows.set(args[0], {id:args[0],owner:args[1],name:args[2],state:args[3],version:0}); return {meta:{changes:1}}; }
            if (sql.startsWith('INSERT INTO agents')) { db.agents.set(args[0], {project:args[1],name:args[2],role:args[3]}); return {meta:{changes:1}}; }
            if (sql.startsWith('UPDATE projects SET state=')) { const row = db.rows.get(args[1]); if (row.version !== args[2]) return {meta:{changes:0}}; row.state = args[0]; row.version++; db.writes++; return {meta:{changes:1}}; }
            throw Error('Unhandled run query: ' + sql);
          },
        }; } };
      },
    };
    const git = { files: new Map(), beforeSave: null,
      async save(files, parent, description, actor) {
        if (this.beforeSave) { const hook = this.beforeSave; this.beforeSave = null; await hook(); }
        const oid = createHash('sha1').update(JSON.stringify([files,parent,description,actor,++db.commits])).digest('hex');
        this.files.set(oid, structuredClone(files));
        return {oid, meta:{message:description, author:actor, timestamp:Date.now(), parent}};
      },
    };
    globalThis.__ownerValidationEnvironment = {DB:db, BUCKET:{}};
    globalThis.__ownerValidationGit = git;
    const {POST} = await import(pathToFileURL(checkout + '/app/api/avc/route.ts').href);
    const {digest} = await import(pathToFileURL(checkout + '/lib/avc/auth.ts').href);
    const {decodeState, encodeState} = await import(pathToFileURL(checkout + '/lib/avc/state-codec.ts').href);
    const ownerCookie = 'synthetic-local-owner', strangerCookie = 'synthetic-local-stranger';
    db.sessions.set(await digest(ownerCookie), {user:'local-owner',email:'owner@example.com'});
    db.sessions.set(await digest(strangerCookie), {user:'local-stranger',email:'stranger@example.com'});
    const request = async (body, credential = ownerCookie, expect = 200, expectedCode) => {
      const headers = {'Content-Type':'application/json', ...(credential.startsWith('avc_') ? {Authorization:'Bearer ' + credential} : {Cookie:'avc_session=' + credential})};
      const response = await POST(new Request('http://127.0.0.1/api/avc', {method:'POST',headers,body:JSON.stringify(body)}));
      const result = await response.json();
      assert.equal(response.status, expect, result.error + ' (' + result.code + ')');
      if (expectedCode) assert.equal(result.code, expectedCode);
      return result.result ?? result;
    };
    const read = project => decodeState(db.rows.get(project).state);
    const update = (project, fn) => {const row = db.rows.get(project), s = decodeState(row.state); fn(s); row.state = encodeState(s); row.version++;};
    const projectFiles = { 'f.txt':'a\nb\nc\nd\ne\nf', 'empty.txt':'', 'other.txt':'first\nsecond\nthird' };
    const projects = [];
    async function fixture(label = 'Fixture', files = projectFiles) {
      const {project} = await request({action:'create_project',name:label,files}); projects.push(project);
      const worker = await request({action:'create_agent',project,name:'Worker'});
      const other = await request({action:'create_agent',project,name:'Other'});
      const act = (action, body = {}, credential = worker.token, expect = 200, code) => request({action,project,requestId:crypto.randomUUID(),...body},credential,expect,code);
      return {project,worker,other,act};
    }
    async function candidate(f, path = 'f.txt', content = 'a\nB\nc\nd\ne\nf', whole = true, range = [1,1]) {
      const {journey} = await f.act('create_journey',{title:'Exact approved candidate'});
      const {changeset} = await f.act('create_changeset',{journey,description:'Publish'});
      const revision = read(f.project).head;
      const grant = await f.act('acquire',{journey,changeset,revision,scopes:[{path,start:range[0],end:range[1],...(whole ? {whole:true} : {})}]});
      const tokens = grant.locks.map(l => l.token);
      const patch = await f.act('patch',{journey,changeset,revision,tokens,description:'Immutable candidate',edits:[{path,content}]});
      await f.act('declare_breaking',{journey,changes:[]});
      await f.act('submit',{journey,revision:patch.revision});
      await f.act('review',{journey,revision:patch.revision,kind:'approve'},ownerCookie);
      return {journey,revision:patch.revision,tokens};
    }
    const integration = (f,c,extra={}) => ({action:'integrate',project:f.project,requestId:crypto.randomUUID(),journey:c.journey,revision:c.revision,head:read(f.project).head,cursor:read(f.project).integrationCursor,...extra});
    const assertions = [];
    for (const leaseCase of ['zero','expired','own-live']) {
      const f=await fixture(leaseCase), c=await candidate(f);
      update(f.project,s=> { if (leaseCase === 'zero') s.leases=[]; if (leaseCase === 'expired') s.leases.forEach(l=>l.expires=Date.now()-1); });
      const before = read(f.project), payload = integration(f,c);
      const result = await request(payload);
      const after = read(f.project);
      assert.equal(after.journeys[0].status,'integrated');
      assert.equal(after.head,result.revision);
      assert.equal(after.leases.length,0);
      assert.equal(after.events.filter(e=>e.type==='journey.integrated').length,1);
      const replay = await request(payload);
      assert.deepEqual(replay,result);
      assert.equal(read(f.project).sequence,after.sequence);
      await request({...payload, cursor:payload.cursor+1}, ownerCookie,409,'idempotency_conflict');
      assertions.push('owner ' + leaseCase + '; exact replay + changed payload denial');
    }
    // Forged owner flags must not bypass actual worker authentication, and worker coverage still matters.
    {
      const f=await fixture('Worker safety'), c=await candidate(f);
      update(f.project,s=>s.leases=[]);
      await request(integration(f,c,{owner:true,agent:false,user:{agent:false},principal:{agent:false}}),f.worker.token,409,'locks_required');
      update(f.project,s=> { s.leases=[{id:'own',token:'synthetic-token',journey:c.journey,changeset:s.journeys[0].changesets[0].id,path:'f.txt',start:6,end:6,canonicalStart:5,canonicalEnd:6,revision:c.revision,expires:Date.now()+600000,generation:1}]; });
      await request(integration(f,c,{tokens:['synthetic-token']}),f.worker.token,409,'lock_coverage');
      await request(integration(f,c),strangerCookie,403,'forbidden');
      assertions.push('forged flags, strict worker tokens/coverage, foreign account');
    }
    // Unchanged worker behavior accepts complete live coverage but rejects missing, stale, and expired editing tokens.
    for (const [label,caseKind,code] of [
      ['worker complete live coverage','valid',undefined],
      ['worker missing current tokens','missing','invalid_lease'],
      ['worker stale token','stale','invalid_lease'],
      ['worker expired leases','expired','locks_required'],
    ]) {
      const f=await fixture(label),c=await candidate(f);
      if (caseKind==='expired') update(f.project,s=>s.leases.forEach(l=>l.expires=Date.now()-1));
      const tokens=caseKind==='valid' || caseKind==='expired' ? c.tokens : caseKind==='stale' ? ['superseded'] : [];
      const before=read(f.project),payload=integration(f,c,{tokens});
      await request(payload,f.worker.token,code ? 409 : 200,code);
      if (code) assert.equal(read(f.project).journeys[0].status,'review');
      else assert.equal(read(f.project).journeys[0].status,'integrated');
      assertions.push(label);
    }
    // Each validation gate is tested with zero leases to ensure owner bypass is strictly limited to leases.
    for (const [label,mutate,body,code] of [
      ['stale candidate',null,{revision:'old'},'stale_integration'],
      ['stale main',null,{head:'old'},'stale_integration'],
      ['stale cursor',null,{cursor:99},'stale_integration'],
      ['unresolved request',s=>s.journeys[0].reviews.push({id:'changes',kind:'request_changes',revision:s.journeys[0].head,actor:'local-owner',body:'Fix this',at:0}),{},'changes_requested'],
      ['missing declaration',s=>s.journeys[0].manifestDeclared=false,{},'manifest_required'],
      ['unreconciled',s=>s.journeys[0].reconciledCursor=-1,{},'reconciliation_required'],
      ['missing approval',s=>s.journeys[0].reviews=[],{},'approval_required'],
      ['old approval',s=>s.journeys[0].reviews.forEach(r=>r.revision='old'),{},'approval_required'],
      ['resolved approval',s=>s.journeys[0].reviews.forEach(r=>r.resolved=true),{},'approval_required'],
    ]) {
      const f=await fixture(label),c=await candidate(f); update(f.project,s=> {s.leases=[]; mutate?.(s);});
      const before=read(f.project), commits=db.commits;
      await request(integration(f,c,body),ownerCookie,409,code);
      assert.deepEqual(read(f.project),before); assert.equal(db.commits,commits);
      assertions.push(label);
    }
    // Live leases from other Journeys protect precise final changes, including empty-file create/delete and boundary insertions.
    for (const [label,path,content,scope,blocked] of [
      ['whole-file conflict','f.txt','a\nB\nc\nd\ne\nf',{path:'f.txt',start:1,end:1,whole:true},true],
      ['range overlap','f.txt','a\nB\nc\nd\ne\nf',{path:'f.txt',start:2,end:2},true],
      ['ordinary adjacent replacement','f.txt','a\nB\nc\nd\ne\nf',{path:'f.txt',start:3,end:4},false],
      ['insertion at range start','f.txt','a\nb\ninserted\nc\nd\ne\nf',{path:'f.txt',start:3,end:4},true],
      ['insertion at range end','f.txt','a\nb\nc\nd\ninserted\ne\nf',{path:'f.txt',start:3,end:4},true],
      ['disjoint prefix insertion','f.txt','inserted\na\nb\nc\nd\ne\nf',{path:'f.txt',start:3,end:4},false],
      ['create empty file','new-empty.txt','',{path:'new-empty.txt',start:1,end:1,whole:true},true],
      ['delete empty file','empty.txt',null,{path:'empty.txt',start:1,end:1},true],
      ['delete nonempty file','f.txt',null,{path:'f.txt',start:6,end:6},true],
    ]) {
      const f=await fixture(label),c=await candidate(f,path,content);update(f.project,s=>s.leases=[]);
      const {journey}=await f.act('create_journey',{title:'Protected other Journey'},f.other.token);
      const {changeset}=await f.act('create_changeset',{journey,description:'Protected work'},f.other.token);
      const grant=await f.act('acquire',{journey,changeset,revision:read(f.project).head,scopes:[scope]},f.other.token);
      assert.equal(grant.queued,false);
      const before=read(f.project),payload=integration(f,c);
      await request(payload,ownerCookie,blocked ? 409 : 200,blocked ? 'integration_lock_conflict' : undefined);
      const after=read(f.project);
      if (blocked) assert.deepEqual(after,before);
      else {
        assert.equal(after.leases.length,1);
        assert.equal(after.leases[0].token,grant.locks[0].token);
        if (label==='disjoint prefix insertion') {
          assert.equal(after.leases[0].canonicalStart,3);
          assert.equal(after.leases[0].canonicalEnd,5);
        }
      }
      assertions.push(label);
    }
    // Simultaneous identical requests race through Git I/O, but commit exactly one receipt/event in state.
    {
      const f=await fixture('Concurrent exact receipt'),c=await candidate(f);update(f.project,s=>s.leases=[]);
      const payload=integration(f,c);let competing;
      git.beforeSave=async()=>{competing=await request(payload);};
      const response=await request(payload);
      assert.deepEqual(response,competing);
      assert.equal(read(f.project).events.filter(e=>e.type==='journey.integrated').length,1);
      assertions.push('concurrent exact integration retry commits one receipt/event');
    }
    // An overlapping lock arriving after preflight but during Git I/O must force a fresh check on CAS retry.
    {
      const f=await fixture('CAS conflict safety'),c=await candidate(f); update(f.project,s=>s.leases=[]);
      const payload=integration(f,c);
      git.beforeSave=()=>update(f.project,s=>s.leases.push({id:'race-lock',token:'do-not-leak',journey:'other-journey',changeset:'other',path:'f.txt',start:2,end:2,canonicalStart:1,canonicalEnd:2,revision:s.head,expires:Date.now()+600000,generation:2}));
      await request(payload,ownerCookie,409,'integration_lock_conflict');
      const s=read(f.project); assert.equal(s.journeys[0].status,'review');assert.equal(s.head,payload.head);assert.equal(s.events.filter(e=>e.type==='journey.integrated').length,0);assert.equal(s.leases.length,1);
      assertions.push('CAS retry rejects new conflicting lock without advancing main');
    }
    // A competing advance of canonical main also invalidates the exact originally submitted request on retry.
    {
      const f=await fixture('CAS head safety'),c=await candidate(f);update(f.project,s=>s.leases=[]);
      const payload=integration(f,c);
      git.beforeSave=()=>update(f.project,s=>{s.head='competing-main';s.integrationCursor=100;});
      await request(payload,ownerCookie,409,'stale_integration');
      const s=read(f.project);assert.equal(s.journeys[0].status,'review');assert.equal(s.head,'competing-main');assert.equal(s.events.filter(e=>e.type==='journey.integrated').length,0);
      assertions.push('CAS retry rejects concurrently advanced main');
    }
    assert.equal(assertions.length, 29);
});
