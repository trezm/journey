import assert from 'node:assert/strict';
import test from 'node:test';
import retiredHost from '../build/sites-worker.ts';

test('the former host redirects browser navigation without copying query credentials', async () => {
  for (const method of ['GET', 'HEAD']) {
    const response = await retiredHost.fetch(new Request('https://old.example/settings?token=private', {method}));
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), 'https://journey.peter-s-mertz.workers.dev');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('old API, export and write requests cannot forward credentials or change old storage', async () => {
  for (const [method, path] of [['GET', '/api/avc'], ['GET', '/api/git/repository/info/refs'],
    ['POST', '/api/avc'], ['POST', '/api/import'], ['DELETE', '/'],
    ['GET', '/__journey_migration_export'], ['POST', '/__journey_migration_import']]) {
    const response = await retiredHost.fetch(new Request('https://old.example' + path, {
      method, headers: {Authorization: 'Bearer private'},
    }));
    assert.equal(response.status, 410);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.error, 'site_moved');
    assert.equal(body.origin, 'https://journey.peter-s-mertz.workers.dev');
    assert.ok(!JSON.stringify(body).includes('Bearer private'));
  }
});
