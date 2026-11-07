# Gmail Access and Recovery Boundaries

## Three identities

Google OAuth authorizes the intended Gmail inbox. The API's Azure managed identity reads the protected authorization bundle from Key Vault. The private worker signs into the business provider and saves that session. None of those identities gives a staff user an application role; staff sign-in remains a separate Entra boundary.

The direct runtime reuses an approved Google OAuth application, not a transferable authorization to every inbox. An owner must authorize the intended mailbox. The runtime refreshes a short-lived access token, checks the returned scope where supplied, then asks Gmail for the actual account profile and compares it with the configured mailbox before retrieval.

Read-only access prevents mailbox modification through this grant, but it still permits broad mailbox reading. Query filters and exact sender rules are application restrictions, not a narrower Google OAuth permission. Prefer a dedicated, authorized inbox and minimize who can read the authorization secret.

## Secret and token handling

The complete reference reads a versioned authorization bundle from Key Vault through `DefaultAzureCredential`. It validates its shape, expected scope, mailbox binding and configured profile. Before submitting a candidate it rechecks the secret version and the enable switch. The public repository contains no authorization bundle or credentials.

A Google external app left in Testing can have short-lived refresh authorization for Gmail scopes. The original setup moved to In production after completing required branding, then renewed consent. Publishing status is not a substitute for verification, user consent, account checks or organization policy. Confirm applicable Google requirements before commissioning a new app.

## Bounded transport

Only HTTPS requests to `oauth2.googleapis.com` and `gmail.googleapis.com` are allowed, without alternate ports or URL credentials. Redirects are rejected. HTTP bodies are bounded before JSON parsing, and abort signals carry deadlines. Errors become limited categories such as authorization, throttled or transport; raw provider messages and tokens are not returned as diagnostics.

The mailbox planner limits each lookup to its request, challenge, send generation, credential version and verified profile. It bounds enumeration to five pages and twenty messages and requires complete discovery before selection. Those limits belong to MFA lookup, not the document-ingestion Logic App's different pagination limits.

## Candidate verification and claims

The full raw-message verifier checks cryptographic sender evidence, required signed headers, recipient, exact subject/template and supported MIME shape. The candidate helper trusts only evidence produced by that internal verification chain. A browser or arbitrary HTTP caller must never be allowed to supply `authenticatedSender: true` as proof.

Multiple eligible messages remain ambiguous, including messages containing the same code. A regular browser sign-in can generate a competing message without an application request ID. The original owner confirmed one provider account per inbox; that does not eliminate overlapping challenges from different browsers.

The full SQL store rechecks the lease, request/challenge/generation, credential and command slot in an atomic transaction. It records a keyed message hash and encrypted command, not plaintext email/code. The worker must verify protected access and persist its new session before Ready. A reused valid session can succeed without a fresh email claim; it is not proof of a new challenge.

## Timestamp precision repair

Gmail can report an arrival at whole-second precision while confirmed Send time includes milliseconds. The repaired comparison allows only the exact second bucket containing Send. An older precise timestamp, previous second, future time or expired request is still rejected by the surrounding checks. This is a precision correction, not a general grace period.

## Code boundaries

The public runnable files exercise transport with fake HTTP responses, request planning, enumeration and candidate decisions. The verifier, Key Vault lookup, SQL claim and session orchestration are reference files with omitted dependencies. Fictional tests do not prove current Google authorization, real DKIM/DNS behavior, SQL concurrency or worker sign-in.

References: [Gmail OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [Gmail message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
