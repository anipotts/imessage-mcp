# RC.2 and stable release

The local candidate is `2.0.0-rc.2`, built from `origin/main` plus the correctness fixes, documentation, package cleanup, and simplified release policy. The separate `release/2.0.0-real-demo` branch remains intact. RC.2 is not published by preparing this checkout or tarball.

1. Review the changes and let the exact-head PR checks pass. The live `main` ruleset requires PRs, strict required checks, signed commits, resolved review threads, and prohibits deletion and non-fast-forward updates. It has no bypass actors. Re-read the rules and PR head before merging.
2. Merge through GitHub's protection, then push a signed `v<version>` tag at the merged commit. The tag workflow binds the tag to `package.json`, re-runs `npm run verify` and the million-message performance gate on that exact revision, and runs Gitleaks and CodeQL against it.
3. Let the tag workflow publish. It packs once, publishes that tarball to npm with provenance over GitHub OIDC, compares the public tarball byte-for-byte, then publishes MCP Registry metadata and an immutable GitHub release from separate least-privilege jobs.
4. Prepare `2.0.0` from protected `main` and update the versioned manifests, changelog, and setup examples together. Stable may contain reviewed runtime fixes. The workflow requires a stable tag's commit to be an ancestor of `main` and publishes to `latest`.
5. Once install and demo links work publicly, send the reviewed Glama correction. Ani submits the Awesome Claude Code web form under its current human-only submission rule. See [prepared listing text](LISTINGS.md).

The automated installed test and demo use empty temporary projects on the current Mac with synthetic databases. A clean Mac's real Messages permission/onboarding flow has not been checked in this run. Existing platform and live-history evidence is marked historical in [verification](../VERIFICATION.md).

No branch-protection settings, credentials, publishing environments, public comments, or directory accounts were changed during preparation.
