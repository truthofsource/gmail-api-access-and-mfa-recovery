# Operating and Scaling Gmail Access

## Troubleshooting

| Outcome | Meaning and next check |
| --- | --- |
| Configuration | Check protected bundle shape, expected mailbox, profile and credential binding without printing values |
| Authorization | Check owner consent, token lifecycle, scope, actual account and cryptographic sender verification |
| Throttled / transport | Respect provider limits; check the results from the limited lookup rather than starting a resend loop |
| No candidate | Confirm the email reached the authorized inbox inside the request window; do not confuse this with a malformed response |
| Ambiguous | More than one eligible message; check competing browser sign-ins and use manual recovery |
| Expired | Request, worker lease or token deadline no longer permits submission; do not revive an old code |
| Submitted | A command was queued; protected provider access and session persistence still need confirmation |

Preserve manual entry as a fallback. A failed/cancelled reconnect with the same credential version has a one-hour cooldown in the documented full application; an already-attempted outage is not repeatedly retried automatically after cooldown. Those policy checks live outside the selected pure helpers.

## Scaling without mixing accounts

The recorded design uses one provider account per authorized inbox and avoids overlapping challenges. Adding more employees does not necessarily add more provider accounts. Measure lookup rate, enumeration time, quota responses, stale/ambiguous candidates, session reuse and manual fallback frequency before increasing concurrency.

Multiple provider accounts require explicit mailbox/profile bindings, isolated request state and reviewed secret access. Using the same Google OAuth application does not share a user's mailbox permission. Do not widen a single inbox search and infer account ownership from a code or display name.

API instances may scale independently, but database request ownership and one-time message claims must prevent duplicate commands. A Key Vault cache must still respect version changes and revocation; the current reference checks version again before submission. The local helper tests do not establish correct behavior when multiple API instances compete for the same request.

## Strengths and tradeoffs

Direct API calls remove an Azure connector dependency but add code and operational responsibility. Read-only scope prevents changes while still exposing mailbox contents to the authorized application. Strict verification reduces wrong-message selection but intentionally sends unusual formats and competing messages to manual recovery.

Refresh tokens, encryption keys, request state and worker sessions need coordinated protection. Restoring a session blob does not prove the external session is still accepted. Never replay a backed-up verification command. Retain audit outcomes without plaintext codes or raw messages.

Costs include API compute, Key Vault operations, state/command storage, logging and worker execution. Avoid repeated polling after the request is terminal. No cloud resource or paid service is activated by this repository's local checks.
