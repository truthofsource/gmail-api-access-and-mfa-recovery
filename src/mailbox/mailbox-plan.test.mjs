import test from 'node:test';
import assert from 'node:assert/strict';
import { planMailboxLookup } from './mailbox-plan.js';

const now = Date.parse('2026-10-20T12:00:00Z');
const config = {
  enabled: true, provider: 'gmail', profileVerified: true,
  profileRevision: 'synthetic-v1', mailboxRef: 'fictional-mailbox',
};
const attempt = {
  state: 'enter_code', commandPending: false, interactive: true,
  leaseVerified: true, singleActiveAttempt: true,
  requestId: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
  challengeId: 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB',
  sendGeneration: 'synthetic-send-1', credentialVersion: 'synthetic-version',
  sentAtMs: now - 10_000, sessionExpiresMs: now + 250_000,
  leaseExpiresMs: now + 900_000,
};
const plan = (c = {}, a = {}, clock = now) =>
  planMailboxLookup({ ...config, ...c }, { ...attempt, ...a }, clock);

test('defaults off; no valid config means no mailbox lookup', () => {
  assert.deepEqual(planMailboxLookup(undefined, undefined, now),
    { ok: false, reason: 'disabled' });
  assert.equal(plan({ enabled: false }).ok, false);
});
test('requires confirmed Gmail profile and safe opaque references', () => {
  for (const c of [
    { provider: 'unknown' }, { profileVerified: false },
    { profileRevision: '' }, { mailboxRef: 'private@example.invalid' },
  ]) assert.equal(plan(c).ok, false);
});
test('human initiation, single active attempt and exact state required', () => {
  for (const a of [
    { state: 'send_email' }, { state: 'verifying' }, { state: 'cancelled' },
    { commandPending: true }, { commandPending: undefined },
    { interactive: false }, { leaseVerified: false }, { singleActiveAttempt: false },
  ]) assert.equal(plan({}, a).ok, false);
});
test('invalid request/challenge/version/generation never creates a plan', () => {
  for (const a of [
    { requestId: 'invalid' }, { challengeId: '' },
    { sendGeneration: '' }, { credentialVersion: null },
  ]) assert.equal(plan({}, a).reason, 'invalid_binding');
});
test('malformed clocks and future send are rejected', () => {
  for (const a of [
    { sentAtMs: now + 1 }, { sentAtMs: NaN }, { sentAtMs: 'today' },
    { leaseExpiresMs: Infinity }, { sessionExpiresMs: null },
    { providerExpiresMs: 'unknown' },
  ]) assert.equal(plan({}, a).reason, 'invalid_time');
  assert.equal(plan({}, {}, NaN).reason, 'invalid_time');
});
test('earliest bound wins and equality is expired', () => {
  assert.equal(plan().deadlineMs, attempt.sessionExpiresMs);
  assert.equal(plan({}, { providerExpiresMs: now + 1000 }).deadlineMs, now + 1000);
  assert.equal(plan({}, { leaseExpiresMs: now + 31_000 }).deadlineMs, now + 1000);
  for (const a of [
    { providerExpiresMs: now }, { sessionExpiresMs: now },
    { leaseExpiresMs: now + 30_000 }, { sentAtMs: now - 300_000 },
  ]) assert.equal(plan({}, a).reason, 'expired');
});
test('plan is bounded, read-only and does not echo arbitrary inputs', () => {
  const result = plan({ rawMessage: 'NEVER_ECHO' }, { code: 'NEVER_ECHO' });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, attempt.requestId.toLowerCase());
  assert.equal(result.maxPages, 5);
  assert.equal(result.maxMessages, 20);
  assert.equal(result.maxDecodedBytesPerMessage, 262_144);
  assert.equal(result.automaticSubmission, false);
  assert.equal(result.includeSpamTrash, false);
  assert.equal(result.candidateNotBeforeMs, attempt.sentAtMs);
  assert.equal(JSON.stringify(result).includes('NEVER_ECHO'), false);
  assert.equal(result.queryAfterEpochSeconds, Math.floor(attempt.sentAtMs / 1000) - 1);
});
test('planner leaves input snapshots unchanged', () => {
  const c = Object.freeze({ ...config });
  const a = Object.freeze({ ...attempt });
  assert.equal(planMailboxLookup(c, a, now).ok, true);
  assert.equal(a.requestId, attempt.requestId);
});
