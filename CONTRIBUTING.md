# Contributing

Use synthetic data only. Do not attach or commit Messages databases, WAL files, AddressBook data, attachments, message text, names, handles, group titles, URLs, filenames, tokens, home-directory paths, or screenshots from a real archive.

## Changes

1. Start from `main` and keep one focused change per commit.
2. Extend the synthetic fixtures in `tests/fixture.ts`; never use a real database in an automated test.
3. Run `npm ci` and `npm run verify` (typecheck, unit tests, the end-to-end suite, audit, pack). Before a release the maintainer runs `npm run preflight`, which adds the performance gates, the desktop bundle, and the read-only live parity check against a real archive.
4. Describe the user-facing behavior and the synthetic coverage in the pull request.

imessage-mcp is read-only. Sending or changing messages or contacts, public HTTP exposure, and fixtures built from real data are out of scope.

## Dependency updates

Dependabot pull requests merge themselves once every required check passes and the branch is current with `main`. Two workflows do this with one fine-grained token owned by the repository owner, because GitHub starts no workflow runs for merges made with the built-in token, and Dependabot ignores rebase requests from bots.

Create the token at github.com/settings/personal-access-tokens with access to this repository only and these permissions: Contents, Pull requests, and Workflows set to read and write. Then store it twice, once for Dependabot runs and once for scheduled runs. Each command prompts for the value, so it never lands in shell history:

```sh
gh secret set DEPENDABOT_AUTOMERGE_TOKEN --repo anipotts/imessage-mcp --app dependabot
gh secret set DEPENDABOT_AUTOMERGE_TOKEN --repo anipotts/imessage-mcp --app actions
```

Missing or invalid credentials fail visibly. One failing dependency PR does not stop maintenance attempts for the other PRs; the workflow reports the failed PR numbers at the end.

For changes to maintenance code or workflows, run `python3 -m unittest discover -s tests/maintenance -v`. These checks use synthetic API responses and a mocked CLI, including failures in the middle of a dependency queue. The required security audit job runs them in CI.

The daily `maintenance health` workflow authenticates the Actions secret even when no dependency PRs are open. It reads the actual expiration from GitHub's response header and fails 14 days before expiry, when repository auto-merge is disabled, or when a Dependabot PR remains open for seven days. It also runs after changes to its source and can be started manually. Its failures and recovery steps appear in the Actions run summary. Enable GitHub Actions failure notifications for this repository in your GitHub account; a failed workflow does not guarantee an email or push notification reaches you.

Recovery:

1. For an expiring/invalid token, regenerate the existing repository-scoped token and update **both** secret copies above. The token cannot safely renew itself. Do not put the value in issues, logs, chat, or source.
2. Run `gh workflow run maintenance-health.yml --repo anipotts/imessage-mcp --ref main` and `gh workflow run dependabot-rebase.yml --repo anipotts/imessage-mcp --ref main`. Check their actual conclusions, not just successful dispatch.
3. For a stalled PR, inspect its current checks and conflicts. Required checks and branch protection stay in force; never bypass them to clear a queue.

### Limits of unattended maintenance

This is guarded automation, not a guarantee that a forgotten repository stays healthy forever. The owner token still expires. Removing scheduled token renewals requires a dedicated GitHub App installed only on this repository, with Contents, Pull requests, and Workflows write permissions and short-lived installation tokens minted per run. That is a separate access/credential setup; the current workflows still use the owner token.

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
