# RC.2 and stable release

The local candidate is `2.0.0-rc.2`, built from `origin/main` plus the correctness fixes, documentation, package cleanup, and simplified release policy. The separate `release/2.0.0-real-demo` branch remains intact. RC.2 is not published by preparing this checkout or tarball.

1. Review the changes and let the exact-head PR checks pass. The live `main` ruleset requires PRs, strict required checks, signed commits, resolved review threads, and prohibits deletion and non-fast-forward updates. It has no bypass actors. Re-read the rules and PR head before merging.
2. Merge through GitHub's protection. Create a fresh whole-repository security scan on the exact release source. The existing scan bundle belongs to an older source and must not be reused. The protected attestation workflow verifies its signed evidence commit and exact tarball.
3. Publish RC.2 to `next` through the existing release workflow after the exact-source checks and protected evidence succeed. Verify the public package, installation, provenance, MCP Registry, and GitHub release separately.
4. Prepare `2.0.0` from protected `main`, update the versioned manifests and setup examples together, and run the same release checks against that source. Stable may contain reviewed runtime fixes. The workflow checks that the stable tag's commit is on `main` and publishes the verified artifact to `latest`.
5. Once install and demo links work publicly, send the reviewed Glama correction. Ani submits the Awesome Claude Code web form under its current human-only submission rule. See [prepared listing text](LISTINGS.md).

The automated installed test and demo use empty temporary projects on the current Mac with synthetic databases. A clean Mac's real Messages permission/onboarding flow has not been checked in this run. Existing platform and live-history evidence is marked historical in [verification](../VERIFICATION.md).

No branch-protection settings, credentials, publishing environments, public comments, or directory accounts were changed during preparation.
