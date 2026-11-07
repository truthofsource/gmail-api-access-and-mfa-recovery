// Internal mailbox helper; only authoritative server state may supply its inputs.
// Offline foundation. Inputs must come from an authenticated, authoritative
// ticket read, never directly from a caller. This does not claim or send a code.
const { constants, createPublicKey, publicEncrypt } = require('node:crypto');
const { candidateBinding, candidateFields } = require('./candidate-binding.js');

const uuid = value => typeof value === 'string' &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
const ref = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const fields = ['environment', 'accountRef', 'requestId', 'challengeId', 'leaseRef',
  'credentialVersion', 'sendGeneration', 'mailboxRef', 'profileRevision'];

function sealCandidate(candidate, ticket, current, nowMs) {
  const reject = reason => ({ ok: false, reason });
  if (candidate?.ok !== true || !ref(candidate.messageRef) ||
      typeof candidate.code !== 'string' || !/^[0-9]{4,12}$/.test(candidate.code))
    return reject('invalid_candidate');
  if (!ticket || !current || !uuid(ticket.requestId) || !uuid(ticket.challengeId) ||
      !fields.every(field => ref(ticket[field]) && ticket[field] === current[field]))
    return reject('binding_changed');
  const provenance = candidateBinding(candidate.binding);
  const expected = candidateBinding(ticket);
  if (!provenance || !expected || !candidateFields.every(field => provenance[field] === expected[field]))
    return reject('candidate_binding_changed');
  if (current.state !== 'enter_code' || current.commandPending !== false ||
      current.manualTakeover !== false || current.lookupAllowed !== true)
    return reject('attempt_ineligible');
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0 ||
      ![candidate.deadlineMs, ticket.expiresAtMs, current.expiresAtMs].every(value => Number.isSafeInteger(value) && value > nowMs))
    return reject('expired');
  if (typeof current.publicKey !== 'string' || current.publicKey.length > 4096 ||
      current.publicKey !== ticket.publicKey || !current.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
    return reject('invalid_key');
  let plaintext;
  try {
    const key = createPublicKey(current.publicKey);
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 2048)
      return reject('invalid_key');
    plaintext = Buffer.from(candidate.code, 'ascii');
    const ciphertext = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256', oaepLabel: Buffer.from(ticket.requestId.toLowerCase() + ':' + ticket.challengeId.toLowerCase()) }, plaintext).toString('base64');
    return { ok: true, messageRef: candidate.messageRef, ciphertext,
      requestId: ticket.requestId.toLowerCase(), challengeId: ticket.challengeId.toLowerCase(),
      sendGeneration: ticket.sendGeneration, automaticSubmission: false };
  } catch {
    return reject('encryption_failed');
  } finally {
    plaintext?.fill(0);
    // JavaScript strings cannot be reliably zeroed; keep candidate scope short
    // and never persist/log it. Buffer clearing is not a whole-process guarantee.
  }
}

exports.sealCandidate = sealCandidate;
