# GitHub App for Jarvis (owner how-to)

Jarvis reads pull request, issue and CI state through a **read-only GitHub App**. It replaces per-owner tokens: one App, installed on your account and on each organization. Jarvis never writes to GitHub. The App's permissions are Metadata, Pull requests, Issues, Checks, Commit statuses and Actions, all **read**. Its webhook events are pull requests, reviews, issues, check suites and workflow runs.

No secret ever goes through chat or an agent. You confirm on GitHub with your own passkey, and the App's keys go straight from GitHub to the Jarvis server, which stores them encrypted.

## Create it (new App)

1. Open Jarvis at its **public https address**: GitHub can only send webhooks there. Then go to **Settings → Connections → GitHub → GitHub App**.
2. Keep or edit the name (`Jarvis (<host>)`). GitHub requires it to be unique and at most 34 characters.
3. Choose **My GitHub account** or **An organization** (for example `momentumbets`), then press **Create GitHub App**.
4. GitHub opens and asks you to confirm (passkey or password). Press **Create GitHub App** there.
5. GitHub sends you back to Jarvis, which shows "GitHub App created".
6. Press **Install on GitHub** and install the App on your user account. Install it again on the organization. Pick the repositories each one may read.
7. Back in Jarvis, the installations appear (or press **Refresh installations**).
8. Check **Accounts Jarvis accepts**. The default is the owners of your saved tokens plus the App's owner, so add the organization (`nickbolles, momentumbets`). An installation on any other account is shown as **Ignored** and never used.

The App is **public** only so it can be installed on more than one account. The allowlist is what limits it.

## Connect an App that already exists

Use either of these:

- **In the browser:** open Settings → Connections → GitHub → **Already have an App? Connect it**. Enter the App ID, paste or upload the private key (`.pem`) and, optionally, the webhook secret. Jarvis checks them with GitHub (`GET /app` signed with the App JWT) before saving anything. All three fields are write-only.
- **One-shot import from the App's JSON** (`{id, slug, client_id, client_secret, webhook_secret, pem}`), inside the container, after Jarvis has started once on this version:

  ```sh
  docker exec Jarvis node scripts/import-github-app.mjs /data/private/github-app.json --allow nickbolles,momentumbets
  ```

  The script verifies the App with GitHub, stores it encrypted (same key as the server) and records the installations. It prints only the App id/slug/owner and the installation accounts. It refuses to overwrite an existing App unless you pass `--replace`. `--no-verify` skips the GitHub check, for offline use. Afterwards, press **Refresh installations** so Jarvis reads each installation's repositories.

Then turn the App's webhook **Active** on GitHub (App settings → Webhook). Check that the URL is `<origin>/api/work/github/webhook` and that the secret matches. You can replace the secret in Jarvis at any time (write-only).

## What Jarvis does with it

- **Token order for each repository:** first an allowlisted App installation covering the repository owner (a short-lived installation token, cached until 5 minutes before it expires), then the token saved for that owner, then `JARVIS_GITHUB_TOKEN`.
- **Webhooks:** Jarvis verifies them with the App's secret (or the legacy secret) and handles each delivery once. Deliveries for accounts outside the allowlist are dropped and flagged in the audit log. Installation changes update the list right away.
- **Linked PRs** show **merged** plus **checks green / red / running**: the combined state of the head commit's check suites and commit statuses, read with GETs.
- **Assigned-issue intake** (the Work inbox) still needs a token connection, because an App installation has no "assigned to me".

## Removing it

**Forget this App** in Settings deletes the keys and the installation list in Jarvis. Delete the App on GitHub as well (Settings → Developer settings → GitHub Apps) to revoke it.
