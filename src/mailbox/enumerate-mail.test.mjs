import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateMail } from './enumerate-mail.js';
const clock = 1000000;
const plan = { ok: true, userId: 'me', mailboxRef: 'synthetic', profileRevision: 'synthetic-v1',
  queryAfterEpochSeconds: 999, deadlineMs: clock + 10000 };
const run = (adapter, options = { now: () => clock }) => enumerateMail(plan, adapter, options);
test('fixed bounds across pages, complete enumeration precedes body reads', async () => {
  const calls = [];
  const result = await run({
    list: async args => { calls.push(args); return args.pageToken ? { messages: [{ id: 'b' }] } :
      { messages: [{ id: 'a' }], nextPageToken: 'next' }; },
    get: async args => { assert.equal(calls.length, 2); return { id: args.id }; },
  });
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
  for (const field of ['afterEpochSeconds', 'beforeEpochSeconds', 'mailboxRef', 'profileRevision'])
    assert.equal(calls[0][field], calls[1][field]);
  assert.equal(calls[0].signal.aborted, true);
});
test('empty mailbox is a complete zero-candidate batch', async () => {
  assert.deepEqual(await run({ list: async () => ({}), get: async () => assert.fail() }),
    { ok: true, complete: true, pages: 1, messages: [] });
});
test('malformed successful responses are not an empty mailbox', async () => {
  for (const page of ['not-json-object', [], 123, true]) {
    assert.equal((await run({ list: async () => page, get: async () => assert.fail() })).reason, 'invalid_page');
  }
});
test('pagination loop rejects without fetching bodies', async () => {
  const result = await run({ list: async () => ({ nextPageToken: 'repeat' }), get: async () => assert.fail() });
  assert.equal(result.reason, 'pagination_loop');
});
test('page and candidate limits fail closed', async () => {
  let page = 0;
  assert.equal((await run({ list: async () => ({ nextPageToken: String(++page) }), get: async () => assert.fail() })).reason, 'page_limit');
  assert.equal((await run({ list: async () => ({ messages: Array.from({ length: 21 }, (_, i) => ({ id: String(i) })) }),
    get: async () => assert.fail() })).reason, 'message_limit');
});
test('duplicate IDs and unexpected response identity reject', async () => {
  assert.equal((await run({ list: async () => ({ messages: [{ id: 'a' }, { id: 'a' }] }),
    get: async () => assert.fail() })).reason, 'duplicate_message');
  assert.equal((await run({ list: async () => ({ messages: [{ id: 'a' }] }),
    get: async () => ({ id: 'wrong' }) })).reason, 'message_binding_changed');
});
test('provider failure is normalizedName and never returns a partial batch', async () => {
  const result = await run({ list: async () => ({ messages: [{ id: 'a' }] }),
    get: async () => { throw Error('PRIVATE BODY'); } });
  assert.deepEqual(result, { ok: false, reason: 'adapter_failure' });
});
test('deadline passing during a request rejects its response', async () => {
  let current = clock;
  const result = await run({ list: async () => { current = plan.deadlineMs; return {}; },
    get: async () => assert.fail() }, { now: () => current });
  assert.equal(result.reason, 'expired');
});
test('hung adapter is aborted within a bounded deadline', async () => {
  const shortPlan = { ...plan, deadlineMs: Date.now() + 30 };
  const result = await enumerateMail(shortPlan, { list: async () => new Promise(() => {}), get: async () => assert.fail() });
  assert.equal(result.reason, 'expired');
});
test('list and body requests carry separate byte limits and retain adapter context', async () => {
  const adapter = {
    marker: 'trusted-instance',
    async list(args) {
      assert.equal(this.marker, 'trusted-instance');
      assert.equal(args.maxResponseBytes, 65536);
      return { messages: [{ id: 'a' }] };
    },
    async get(args) {
      assert.equal(this.marker, 'trusted-instance');
      assert.equal(args.maxResponseBytes, 524288);
      return { id: args.id };
    },
  };
  assert.equal((await run(adapter)).ok, true);
});
test('invalid mailbox/profile or reversed query bounds do not call adapter', async () => {
  const adapter = { list: () => assert.fail(), get: () => assert.fail() };
  for (const changes of [{ mailboxRef: '' }, { profileRevision: undefined },
    { queryAfterEpochSeconds: Math.ceil(plan.deadlineMs / 1000) }]) {
    assert.equal((await enumerateMail({ ...plan, ...changes }, adapter, { now: () => clock })).reason, 'invalid_plan');
  }
});
