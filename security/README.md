# sealed release scan

The release tag points to a signed evidence commit whose direct parent is the exact Git revision reviewed by Codex Security. That evidence commit changes only these generated canonical files:

- `security/scan/scan-manifest.json`
- `security/scan/findings.json`
- `security/scan/coverage.json`

Do not edit those files by hand. Copy them byte-for-byte from the completed sealed scan, commit them with the authorized release signer, and run the protected `attest security evidence` workflow on that commit. The workflow validates the canonical hashes, exact parent revision, zero findings, complete whole-repository coverage, package identity, and commit signature before producing attestations.

The scan files are intentionally excluded from the npm package. They remain public in the GitHub release commit so the release evidence can be independently inspected.
