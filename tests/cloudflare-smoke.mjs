import assert from 'node:assert/strict';

const root = process.env.AVC_TEST_URL ?? 'http://127.0.0.1:4173';
const spoof = {
  'oai-authenticated-user-id': 'public-spoof',
  'oai-authenticated-user-email': 'spoof@example.com',
};
async function request(path, { body, headers = {}, status = 200 } = {}) {
  const response = await fetch(root + path, {
    method: body ? 'POST' : 'GET',
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return { response, data: data.result ?? data };
}
const unauthenticated = await request('/api/auth', { headers: spoof });
assert.equal(unauthenticated.data.user, null);
await request('/api/avc', { headers: spoof, status: 401 });
await request('/api/connect', { headers: spoof, body: { project: 'invalid' }, status: 401 });
const registration = await request('/api/auth', {
  body: { action: 'register', email: `cloudflare-${crypto.randomUUID()}@example.com`, password: 'standalone-test-password-2026' },
});
const cookie = registration.response.headers.get('set-cookie').split(';')[0];
const signedIn = await request('/api/auth', { headers: { Cookie: cookie, ...spoof } });
assert(signedIn.data.user && !signedIn.data.user.id.startsWith('siwc:'));
const { data: created } = await request('/api/avc', {
  headers: { Cookie: cookie }, body: { action: 'create_project', name: 'Cloudflare authentication smoke' },
});
const connection = await request('/api/connect', {
  headers: { Cookie: cookie }, body: { project: created.project },
});
assert.equal(connection.data.url, new URL(root).origin);
assert.equal(connection.data.siteToken, undefined);
await request('/api/avc?project=' + created.project, {
  headers: { Authorization: 'Bearer ' + connection.data.token },
});
await request('/api/auth', { headers: { Cookie: cookie }, body: { action: 'logout' } });
const loggedOut = await request('/api/auth', { headers: { Cookie: cookie, ...spoof } });
assert.equal(loggedOut.data.user, null);
console.log('Cloudflare smoke passed: identity header spoofing rejected, cookie sessions and repository agents authenticate, connection origin is standalone, logout revokes the session.');
