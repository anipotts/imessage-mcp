# Contributing

Use synthetic data only. Do not attach or commit Messages databases, WAL files, AddressBook data, attachments, message text, names, handles, group titles, URLs, filenames, tokens, home-directory paths, or screenshots from a real archive.

## Changes

1. Start from `main` and keep one focused change per commit.
2. Extend the synthetic fixtures in `tests/fixture.ts`; never use a real database in an automated test.
3. Run `npm ci` and `npm run verify` (typecheck, unit tests, the end-to-end suite, audit, pack). Before a release the maintainer runs `npm run preflight`, which adds the performance gates, the desktop bundle, and the read-only live parity check against a real archive.
4. Describe the user-facing behavior and the synthetic coverage in the pull request.

imessage-mcp is read-only. Sending or changing messages or contacts, public HTTP exposure, and fixtures built from real data are out of scope.

## Dependency updates

Dependabot pull requests merge themselves once every required check passes and the branch is current with `main`. The private `imessage-mcp-maintenance` GitHub App is installed only on this repository, with Contents, Pull requests, and Workflows write permissions and mandatory Metadata read. It has no account permissions, user OAuth, or webhooks. It must not be added to a branch-protection bypass list.

The runtime configuration is one Actions variable, `MAINTENANCE_APP_CLIENT_ID`, and one Actions secret, `MAINTENANCE_APP_PRIVATE_KEY`. Do not copy the private key into Dependabot secrets. Keep its recovery copy in the approved secret store, never in source or logs. The pinned official `actions/create-github-app-token` action mints a token for only this repository at the start of each job and revokes it at the end. Installation tokens expire after one hour; the App key has no scheduled expiration. No personal-token renewal is needed.

The privileged controllers run only protected `main` code after successful same-repository PR CI, on pushes to main, every three hours, or manually. They never check out PR code or consume PR artifacts with the App key. The two controllers share a concurrency group. Only non-draft Dependabot PRs from this repository targeting `main` are eligible; human PRs and forks are skipped.

The App requests protected auto-merge when a PR is current. For a behind branch it uses GitHub's update-branch API with the expected head SHA, then waits for fresh CI. This avoids owner-only bot comment commands. The added merge commits can stop Dependabot's own rebasing, so the App owns subsequent branch synchronization. It cannot resolve dependency/lockfile conflicts; these remain visible failures. Live protection is rechecked before each mutation, and stale heads cannot be overwritten. One failing dependency PR does not stop attempts for the remaining PRs.

For changes to maintenance code or workflows, run `python3 -m unittest discover -s tests/maintenance -v`. These checks use synthetic API responses and a mocked CLI, including failures in the middle of a dependency queue. The required security audit job runs them in CI.

The daily `maintenance health` workflow mints a read-only installation token even when no dependency PRs are open. It verifies that the token exposes exactly this repository and fails when authentication or repository scope is wrong, repository auto-merge is disabled, or a Dependabot PR remains open for seven days. It also runs after changes to its source and can be started manually. Its failures and recovery steps appear in the Actions run summary. Enable GitHub Actions failure notifications for this repository in your GitHub account; a failed workflow does not guarantee an email or push notification reaches you.

Recovery:

1. For authentication failures, verify that the App is still installed only on this repository, the client ID matches, and the Actions private-key secret matches an active App key. A revoked key or uninstalled App requires an authorized repair. Do not put credentials in issues, logs, chat, or source.
2. Run `gh workflow run maintenance-health.yml --repo anipotts/imessage-mcp --ref main`, `gh workflow run dependabot-rebase.yml --repo anipotts/imessage-mcp --ref main`, and `gh workflow run dependabot-automerge.yml --repo anipotts/imessage-mcp --ref main`. Check their actual conclusions, not just successful dispatch.
3. For a stalled PR, inspect its current checks and conflicts. Required checks and branch protection stay in force; never bypass them to clear a queue.

### Limits of unattended maintenance

This removes scheduled personal-token renewal, not every possible owner action. Revoked App keys, changed permissions, failed checks, merge conflicts, and hosting-policy changes can still require intervention. The previous `DEPENDABOT_AUTOMERGE_TOKEN` copies are unused; they are retained only for rollback until separately retired. Reverting to the previous workflow revision also requires a still-valid owner token in both Actions and Dependabot secrets; retaining an expired value does not provide a working rollback.

GitHub can disable scheduled workflows in a public repository after 60 days without repository activity. A disabled schedule cannot monitor or re-enable itself. Check the workflow state when returning after inactivity, re-enable it through GitHub, and dispatch both maintenance workflows manually. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Dependabot can also pause updates when dependency PRs remain untouched for 90 days, and stops automatically rebasing a PR after 30 days. Check its paused-update banner if no new PRs arrive; an empty queue alone does not prove updates are running. See [Dependabot inactivity and recovery](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-updates-stopped).

Dependency merges update `main`; they do not publish an npm version or a desktop bundle. Release tags and the existing release verification remain the publication boundary. Breaking dependency upgrades, unsupported runners/Node versions, revoked access, and product or security fixes can still need an owner. This maintenance change does not expand publishing, change branch protection, or disable required checks.

## Desktop bundle signing

Claude Desktop marks an extension as signed only when its certificate passes the operating system's code-signing trust check, so a self-signed certificate still installs as unsigned. The release workflow signs `imessage-mcp.mcpb` with an Apple Developer ID Application certificate when these repository secrets exist, and fails the release if the result does not verify as trusted. Without them, releases ship unsigned as before.

1. In the Apple Developer Program, create a Developer ID Application certificate (Xcode, Settings, Accounts, Manage Certificates) and export it with its private key from Keychain Access as a `.p12`.
2. Convert it in a private directory. `openssl` prompts for the export password, so it never lands in shell history. Add `-legacy` if OpenSSL rejects the Keychain export.

```sh
openssl pkcs12 -in developer-id.p12 -clcerts -nokeys -out cert.pem
openssl pkcs12 -in developer-id.p12 -nocerts -nodes -out key.pem
curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer | openssl x509 -inform der -out intermediate.pem
```

3. Store the three files as secrets from stdin, then delete the local copies.

```sh
gh secret set MCPB_SIGNING_CERT --repo anipotts/imessage-mcp < cert.pem
gh secret set MCPB_SIGNING_KEY --repo anipotts/imessage-mcp < key.pem
gh secret set MCPB_SIGNING_INTERMEDIATE --repo anipotts/imessage-mcp < intermediate.pem
rm -P key.pem developer-id.p12
```

The next tagged release signs the bundle. To check a signature locally, point `MCPB_SIGNING_CERT_FILE`, `MCPB_SIGNING_KEY_FILE`, and `MCPB_SIGNING_INTERMEDIATE_FILE` at the PEM files and run `npm run build:mcpb && npm run sign:mcpb`.

## Compatibility reports

Open a bug report with the exact package version, macOS version, Node version, Mac architecture, source mode (`live` or `copy`), service family, transport, privacy ceiling, Contacts mode, tool name, stable error reason, and sanitized timing. Include the relevant `doctor --contacts none --privacy aggregate --json` check names and pass/warn/fail states, not private values.

Provide the smallest synthetic reproduction you can. If a schema capability differs, list only table and column names needed to explain it. Never upload a database, attributed-body blob, contact record, client configuration, screenshot, or raw tool result. Report security issues privately through [SECURITY.md](SECURITY.md).
