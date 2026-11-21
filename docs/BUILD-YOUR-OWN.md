# Build your own from scratch: Gmail Api Access And Mfa Recovery

Your own read-only Gmail OAuth application and a message-selection check that does not expose verification codes.

Start with a new folder, your own files and your own accounts. The numbered steps below describe the build; no portfolio repository checkout is required. The existing implementation/evidence elsewhere in this repository is a separate reference, not a claim that your new build has already passed.

## Prerequisites

A Google Cloud project you control, a test Gmail inbox, Python and permission to configure OAuth consent. This first build reads message metadata only; it does not automatically submit an MFA code or sign in to another service.

Use Bash on Linux/macOS/WSL for Bash blocks and PowerShell for PowerShell blocks. Select the tool versions supported by the official sources below, record the versions you actually install and retain generated dependency locks. Cloud resources, scanner downloads, logs and external AI calls can create costs; review the stated scope before enabling them.

## Create your project folder

Choose a new folder name. These first commands create a blank project; an optional `git init` gives it its own history. Create parent directories in your editor when a later step introduces a nested file.

```bash
mkdir my-gmail-api-access-and-mfa-recovery
cd my-gmail-api-access-and-mfa-recovery
git init
```

Create `.gitignore` before saving credentials or build outputs:

```gitignore
.venv/
node_modules/
.env
.env.*
local.settings.json
credentials.json
token.json
*.pem
*.key
*.tfstate*
*.tfplan
.terraform/
private*/
captures/
backups/
batch.json
reports/
out/
app-config.local.yaml
```

The source/file snippets are a starting implementation you type or paste into the named files. Replace `YOUR_*`, names, regions and addresses only with values from your own lab; do not place real client/employee records in a test project. Keep your terminal in this project root unless a step explicitly changes directory.

Before a first commit, set your own repository-local author with `git config user.name "YOUR_NAME"` and `git config user.email "YOUR_PUBLIC_COMMIT_EMAIL"`. Review `git status --short` and the staged diff before publishing; ignored local files are not a substitute for reviewing what you upload.

## Step 1 — Enable your own API and consent application

**Where:** Google Cloud Console → APIs & Services; Google Auth Platform.

Enable Gmail API in your project. Configure the consent app's branding/audience and authorized test user, choosing the actual mailbox you intend to read; publishing/verification and refresh-token behavior must be reviewed before unattended use.

**Check before continuing:** The project has Gmail API enabled and the intended user may consent.

## Step 2 — Create a desktop OAuth client

**Where:** Google Auth Platform → Clients.

Create a Desktop app client and download its client configuration privately as credentials.json. Keep it outside Git and use a regular browser for consent; do not reuse the portfolio project's client IDs or secrets.

**Check before continuing:** Your own desktop client file is available privately.

## Step 3 — Install your reader dependencies

**Where:** Your new project folder.

Create a virtual environment and install the Google API/OAuth libraries. Record the resolved dependencies in a lock file for your own implementation.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install google-api-python-client google-auth-oauthlib
.venv/bin/python -m pip freeze > requirements.lock.txt
```

**Check before continuing:** The selected interpreter can import the API and OAuth helpers.

## Step 4 — Write the first read-only call

**Where:** Your project folder.

Create reader.py below and privately configure EXPECTED_GMAIL_ADDRESS to the primary address of your intended test inbox before running it. The profile check happens before listing messages; the script saves no refresh token and prints neither the address nor a message body/code.

Create **`reader.py`** with the following contents:

```python
import os
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
expected = os.environ.get('EXPECTED_GMAIL_ADDRESS', '').strip()
if not expected or '@' not in expected:
    raise ValueError('Set the intended primary Gmail address privately before authorizing')
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
flow = InstalledAppFlow.from_client_secrets_file('credentials.json', SCOPES)
credentials = flow.run_local_server(port=0)
gmail = build('gmail', 'v1', credentials=credentials)
profile = gmail.users().getProfile(userId='me').execute()
actual = profile.get('emailAddress') if isinstance(profile, dict) else None
if not isinstance(actual, str) or actual.casefold() != expected.casefold():
    raise RuntimeError('Authorized mailbox does not match the intended primary account; no messages were read')
result = gmail.users().messages().list(userId='me', q='newer_than:1d', maxResults=5).execute()
print({'mailbox_verified': True, 'returned_messages': len(result.get('messages', []))})
```

**Check before continuing:** The code asks only for Gmail read access and reports a bounded message count.

## Step 5 — Authorize and verify the exact mailbox

**Where:** Your terminal and regular browser.

Authorize the intended test inbox in your regular browser and confirm mailbox_verified is true. If the primary account does not match, stop and revoke any unintended consent through that Google account's connected applications before retrying; do not change the expected address just to bypass the mismatch.

```bash
read -r -p 'Expected primary Gmail address: ' EXPECTED_GMAIL_ADDRESS
export EXPECTED_GMAIL_ADDRESS
.venv/bin/python reader.py
```

Enter the intended account's primary address at the private prompt; this avoids putting its literal value into the command history. An alias can differ from the primary profile address. Keep the terminal and callback URLs out of public screenshots.

**Check before continuing:** Your own OAuth client can read the intended account.

## Step 6 — Design MFA selection and fallback

**Where:** Your own protected adapter.

Before using messages for recovery, bind the mailbox to one provider account and match sender authentication, recipient, request time and template; reject ambiguous candidates and regular-browser sign-in codes. Store refresh credentials in a protected vault, serialize reconnect attempts and retain manual fallback rather than repeatedly requesting paid/provider operations.

**Check before continuing:** Automatic recovery has an explicit identity/time contract and remains disabled until that separate flow is accepted.

## Step 7 — Remove access when finished

**Where:** Google account → Security → connected applications.

Revoke your lab consent if it will not be used and remove local client/token material under your retention policy. Retain only a value-free diagram and evidence of the read-only request.

**Check before continuing:** No mailbox credential or code is published.

## Verification and your own screenshots

| Evidence | What to record | Your result |
| --- | --- | --- |
| New build | Your own files/resource settings and tool versions | Not yet recorded |
| Working path | The actual successful request, configuration or recovery result | Not yet recorded |
| Failure boundary | A meaningful denied, malformed, stale or failed case | Not yet recorded |
| Recovery / cleanup | What you restored or removed and what remains billed | Not yet recorded |

Capture your own architecture/configuration, one working result and one failure/recovery result. Keep tokens, credentials, personal records and private identifiers out of public screenshots. The architecture diagram explains the design; record your own results rather than treating it as execution evidence.

## Troubleshooting order

1. Confirm the named file, working directory and selected tool/interpreter.
2. Check the exact input and resource/account selected for the failing step.
3. Separate identity permission, network/DNS reachability and application validation.
4. Keep the actual error and reconcile an unknown write outcome before repeating it; do not widen access or repeat paid operations blindly.

The numbered steps describe a build procedure. Local syntax checks, an accepted API request, a completed hosted operation and a human verification are different evidence levels; fill in the verification table with what you actually observed.

## Official implementation references

- [developers.google.com — python](https://developers.google.com/workspace/gmail/api/quickstart/python)
- [developers.google.com — oauth2](https://developers.google.com/identity/protocols/oauth2)
- [developers.google.com — getProfile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
