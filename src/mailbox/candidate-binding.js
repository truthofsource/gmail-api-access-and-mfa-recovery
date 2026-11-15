// Internal mailbox helper; only authoritative server state may supply its inputs.
// Trusted internal provenance only; not proof of caller authentication.
const candidateFields = ['requestId', 'challengeId', 'credentialVersion',
  'sendGeneration', 'mailboxRef', 'profileRevision'];
function candidateBinding(value) {
  if (!value || !candidateFields.every(field => typeof value[field] === 'string' &&
      /^[A-Za-z0-9_-]{1,80}$/.test(value[field]))) return null;
  if (!['requestId', 'challengeId'].every(field =>
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value[field]))) return null;
  return Object.fromEntries(candidateFields.map(field => [field,
    field === 'requestId' || field === 'challengeId' ? value[field].toLowerCase() : value[field]]));
}

exports.candidateFields = candidateFields;
exports.candidateBinding = candidateBinding;

// Gmail can report internalDate at whole-second precision. Only that exact
// bucket may overlap a millisecond Send timestamp; earlier precise times stay stale.
function receivedAfterConfirmedSend(receivedAtMs, sentAtMs) {
  if (![receivedAtMs, sentAtMs].every(value => Number.isSafeInteger(value) && value > 0)) return false;
  return receivedAtMs >= sentAtMs ||
    (receivedAtMs % 1000 === 0 && receivedAtMs === Math.floor(sentAtMs / 1000) * 1000);
}
exports.receivedAfterConfirmedSend = receivedAfterConfirmedSend;
