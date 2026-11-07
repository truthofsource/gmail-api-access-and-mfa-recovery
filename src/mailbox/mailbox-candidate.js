// Internal mailbox helper; only authoritative server state may supply its inputs.
// gmailMessage verifies raw authenticity; gmailLookupStore owns atomic claims.
// Never expose this function as an endpoint accepting caller-supplied evidence.
const { TextDecoder } = require('node:util');
const { candidateBinding, receivedAfterConfirmedSend } = require('./candidate-binding.js');

const fail = reason => ({ ok: false, reason });
const limits = { messages: 20, pages: 5, bytes: 262144, nodes: 32, depth: 8 };
const parserFailures = new Set(['mime_limit', 'unsupported_mime', 'malformed_mime',
  'malformed_encoding', 'template_mismatch', 'ambiguous']);

function extract(payload, profile) {
  // A verified HTML profile requires both alternatives, never HTML alone.
  if (profile.html && (payload?.mimeType !== 'multipart/alternative' ||
      payload.parts?.length !== 2 ||
      payload.parts.filter(p => p?.mimeType === 'text/plain').length !== 1 ||
      payload.parts.filter(p => p?.mimeType === 'text/html').length !== 1))
    throw new Error('unsupported_mime');
  let bytes = 0;
  let nodes = 0;
  const codes = new Set();
  function visit(part, depth) {
    if (!part || ++nodes > limits.nodes || depth > limits.depth)
      throw new Error('mime_limit');
    if (part.filename || part.body?.attachmentId) throw new Error('unsupported_mime');
    if (part.mimeType === 'multipart/mixed' || part.mimeType === 'multipart/alternative') {
      if (!Array.isArray(part.parts) || !part.parts.length || part.body?.data)
        throw new Error('malformed_mime');
      for (const child of part.parts) visit(child, depth + 1);
      return;
    }
    const template = part.mimeType === 'text/html' ? profile.html : profile;
    if (!template || !['text/plain', 'text/html'].includes(part.mimeType))
      throw new Error('unsupported_mime');
    if (part.parts?.length) throw new Error('malformed_mime');
    const data = part.body?.data;
    if (typeof data !== 'string' || data.length > Math.ceil(limits.bytes * 4 / 3) + 4 ||
        !/^[A-Za-z0-9_-]*={0,2}$/.test(data))
      throw new Error('malformed_encoding');
    const unpadded = data.replace(/=+$/, '');
    const padding = data.length - unpadded.length;
    if (unpadded.length % 4 === 1 ||
        (padding > 0 && (data.length % 4 !== 0 || padding !== (4 - unpadded.length % 4) % 4)))
      throw new Error('malformed_encoding');
    const decoded = Buffer.from(data, 'base64url');
    if (decoded.toString('base64url') !== unpadded) throw new Error('malformed_encoding');
    bytes += decoded.length;
    if (bytes > limits.bytes) throw new Error('mime_limit');
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(decoded); }
    catch { throw new Error('malformed_encoding'); }
    // Exact synthetic grammar; no arbitrary regex, digit scraping or HTML stripping.
    if (!body.startsWith(template.prefix) || !body.endsWith(template.suffix))
      throw new Error('template_mismatch');
    const code = body.slice(template.prefix.length, body.length - template.suffix.length);
    if (code.length !== profile.digits || !/^[0-9]+$/.test(code))
      throw new Error('template_mismatch');
    codes.add(code);
  }
  visit(payload, 0);
  if (codes.size !== 1) throw new Error('ambiguous');
  return [...codes][0];
}

function selectMailboxCandidate(plan, profile, batch, nowMs) {
  if (plan?.ok !== true || !Number.isSafeInteger(nowMs) ||
      !Number.isSafeInteger(plan.deadlineMs) || !Number.isSafeInteger(plan.candidateNotBeforeMs) ||
      nowMs < plan.candidateNotBeforeMs || nowMs >= plan.deadlineMs)
    return fail('invalid_or_expired_plan');
  if (!profile || typeof profile.revision !== 'string' || !profile.revision.length ||
      profile.revision !== plan.profileRevision ||
      typeof profile.prefix !== 'string' || !profile.prefix.length || profile.prefix.length > 4096 ||
      typeof profile.suffix !== 'string' || !profile.suffix.length || profile.suffix.length > 4096 ||
      !Number.isInteger(profile.digits) || profile.digits < 4 || profile.digits > 12)
    return fail('invalid_profile');
  if (profile.html !== undefined && (!profile.html ||
      typeof profile.html.prefix !== 'string' || !profile.html.prefix.length || profile.html.prefix.length > 16384 ||
      typeof profile.html.suffix !== 'string' || !profile.html.suffix.length || profile.html.suffix.length > 16384))
    return fail('invalid_profile');
  const binding = candidateBinding(plan);
  if (!binding) return fail('invalid_binding');
  if (batch?.complete !== true || !Number.isInteger(batch.pages) || batch.pages < 1 ||
      batch.pages > limits.pages || !Array.isArray(batch.messages) ||
      batch.messages.length > limits.messages) return fail('incomplete_or_oversized_batch');
  const ids = new Set();
  const candidates = [];
  for (const message of batch.messages) {
    if (!message || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.id))
      return fail('invalid_message');
    // Duplicate pages could conceal conflicting bodies; do not silently dedupe.
    if (ids.has(message.id)) return fail('duplicate_message');
    ids.add(message.id);
    if (!Number.isSafeInteger(message.receivedAtMs) || message.receivedAtMs > nowMs)
      return fail('invalid_message_time');
    if (!receivedAfterConfirmedSend(message.receivedAtMs, plan.candidateNotBeforeMs)) continue;
    const evidence = message.trustedEvidence;
    if (evidence?.mailboxRef !== plan.mailboxRef || evidence?.profileRevision !== plan.profileRevision ||
        evidence?.authenticatedSender !== true || evidence?.recipientMatches !== true ||
        evidence?.accountCorrelation !== true) return fail('untrusted_candidate');
    if (message.previouslyClaimed !== false) return fail('claimed_or_unknown');
    try { candidates.push({ messageRef: message.id, code: extract(message.payload, profile) }); }
    catch (error) { return fail(parserFailures.has(error?.message) ? error.message : 'malformed_mime'); }
  }
  if (!candidates.length) return fail('no_candidate');
  if (candidates.length !== 1) return fail('ambiguous');
  // Sensitive in-memory value for the internal encryptor; never log/serialize to HTTP.
  return { ok: true, ...candidates[0], binding, deadlineMs: plan.deadlineMs, automaticSubmission: false };
}

exports.selectMailboxCandidate = selectMailboxCandidate;
