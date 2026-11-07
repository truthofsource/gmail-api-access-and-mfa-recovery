// Internal mailbox helper; only authoritative server state may supply its inputs.
// Pure enumeration contract; gmailTransport supplies private credential access.
// The adapter must enforce abort signals and HTTP response byte limits
// BEFORE parsing JSON. This helper cannot bound an already-materialized payload.
async function enumerateMail(plan, adapter, { now = Date.now } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (plan?.ok !== true || !Number.isSafeInteger(plan.deadlineMs) ||
      !Number.isSafeInteger(plan.queryAfterEpochSeconds) || plan.queryAfterEpochSeconds < 0 ||
      plan.queryAfterEpochSeconds >= Math.ceil(plan.deadlineMs / 1000) ||
      !['mailboxRef', 'profileRevision'].every(field => typeof plan[field] === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(plan[field])) ||
      plan.userId !== 'me' || typeof adapter?.list !== 'function' || typeof adapter?.get !== 'function')
    return fail('invalid_plan');
  const controller = new AbortController();
  const remaining = plan.deadlineMs - now();
  if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 300000) return fail('expired');
  const timer = setTimeout(() => controller.abort(), remaining);
  const ids = new Set();
  const tokens = new Set();
  const messages = [];
  let pages = 0;
  let pageToken;
  // Search profile is resolved privately by adapter, not arbitrary query input.
  const base = { userId: 'me', mailboxRef: plan.mailboxRef,
    profileRevision: plan.profileRevision, afterEpochSeconds: plan.queryAfterEpochSeconds,
    beforeEpochSeconds: Math.ceil(plan.deadlineMs / 1000), includeSpamTrash: false,
    maxResults: 20, maxResponseBytes: 65536, signal: controller.signal };
  async function call(fn, args) {
    if (controller.signal.aborted || now() >= plan.deadlineMs) throw Error('expired');
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(Error('expired'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => fn.call(adapter, args)), aborted]);
      if (now() >= plan.deadlineMs) throw Error('expired');
      return result;
    } finally { controller.signal.removeEventListener('abort', onAbort); }
  }
  try {
    do {
      if (++pages > 5) return fail('page_limit');
      const page = await call(adapter.list, { ...base, pageToken });
      if (!page || typeof page !== 'object' || Array.isArray(page) ||
          (page.messages !== undefined && !Array.isArray(page.messages))) return fail('invalid_page');
      for (const item of page.messages ?? []) {
        if (typeof item?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)) return fail('invalid_message');
        if (ids.has(item.id)) return fail('duplicate_message');
        ids.add(item.id);
        if (ids.size > 20) return fail('message_limit');
      }
      pageToken = page.nextPageToken;
      if (pageToken !== undefined && (typeof pageToken !== 'string' || !pageToken.length || pageToken.length > 2048))
        return fail('invalid_page_token');
      if (pageToken !== undefined) {
        if (tokens.has(pageToken)) return fail('pagination_loop');
        tokens.add(pageToken);
      }
    } while (pageToken !== undefined);
    // Do not fetch bodies until enumeration is complete and bounded.
    for (const id of ids) {
      const message = await call(adapter.get, { ...base, id, format: 'full', maxResponseBytes: 524288 });
      if (message?.id !== id) return fail('message_binding_changed');
      messages.push(message);
    }
    return { ok: true, complete: true, pages, messages };
  } catch {
    // Never propagate provider exception text, headers, response body or code.
    return fail(controller.signal.aborted || now() >= plan.deadlineMs ? 'expired' : 'adapter_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

exports.enumerateMail = enumerateMail;
