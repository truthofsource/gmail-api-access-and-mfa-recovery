// Internal mailbox helper; only authoritative server state may supply its inputs.
// Pure planning helper, not an authorization boundary.
// gmailLookupStore revalidates the trusted snapshot atomically before command submission.
const ref = value => typeof value === 'string' &&
  /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const time = value => Number.isSafeInteger(value) && value > 0;
const deny = reason => ({ ok: false, reason });

function planMailboxLookup(config, attempt, nowMs) {
  if (config?.enabled !== true) return deny('disabled');
  if (config.provider !== 'gmail') return deny('unsupported_provider');
  if (config.profileVerified !== true || !ref(config.profileRevision) ||
      !ref(config.mailboxRef)) return deny('profile_unverified');
  if (!attempt || attempt.state !== 'enter_code' ||
      attempt.commandPending !== false || attempt.interactive !== true ||
      attempt.leaseVerified !== true || attempt.singleActiveAttempt !== true)
    return deny('attempt_ineligible');
  if (!uuid(attempt.requestId) || !uuid(attempt.challengeId) ||
      !ref(attempt.sendGeneration) || !ref(attempt.credentialVersion))
    return deny('invalid_binding');
  if (![nowMs, attempt.sentAtMs, attempt.sessionExpiresMs,
        attempt.leaseExpiresMs].every(time) ||
      attempt.sentAtMs > nowMs ||
      (attempt.providerExpiresMs !== undefined && !time(attempt.providerExpiresMs)))
    return deny('invalid_time');
  const deadlineMs = Math.min(
    attempt.sentAtMs + 300_000,
    attempt.sessionExpiresMs,
    attempt.leaseExpiresMs - 30_000,
    attempt.providerExpiresMs ?? Number.MAX_SAFE_INTEGER
  );
  if (deadlineMs <= nowMs) return deny('expired');
  return {
    ok: true,
    provider: 'gmail',
    userId: 'me',
    mailboxRef: config.mailboxRef,
    profileRevision: config.profileRevision,
    requestId: attempt.requestId.toLowerCase(),
    challengeId: attempt.challengeId.toLowerCase(),
    credentialVersion: attempt.credentialVersion,
    sendGeneration: attempt.sendGeneration,
    // Search overlap only. Final checks allow only the same whole-second
    // Gmail timestamp bucket to overlap a millisecond Send time.
    queryAfterEpochSeconds: Math.max(0, Math.floor(attempt.sentAtMs / 1000) - 1),
    candidateNotBeforeMs: attempt.sentAtMs,
    deadlineMs,
    maxPages: 5,
    maxMessages: 20,
    maxDecodedBytesPerMessage: 262_144,
    includeSpamTrash: false,
    automaticSubmission: false,
  };
}

exports.planMailboxLookup = planMailboxLookup;
