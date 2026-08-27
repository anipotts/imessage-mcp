# 3.0 send-tool research boundary

Every 2.x release remains read-only. This roadmap is a research checklist, not approval to add or ship message mutation.

## permission model

A send-capable major version would need a separate executable boundary with the narrowest Apple Messages automation entitlement available. Read and send authority must be independently configurable. The read-only server must remain usable without send permission.

The design must define behavior for denied, revoked, stale, and partially granted permissions. Permission setup cannot be hidden behind UI automation.

## confirmation

Each send action needs a human-visible preview containing the resolved recipients, service expectation, exact body, attachments, and any fallback behavior. Ambiguous recipients must stop before preview.

Confirmation must be scoped to one immutable request and expire quickly. Bulk, scheduled, reply, reaction, edit, and group-recipient actions require distinct confirmation policies.

## auditability

The caller must receive a stable intent identifier, confirmation evidence, attempted action, Apple-reported result, and final reconciliation state. Logs need deterministic redaction and explicit retention controlled by the operator.

Audit records cannot contain hidden message drafts or silently become a second message archive.

## sandboxing

Sending should run outside the read-only query process with strict input schemas, bounded body and attachment sizes, fixed Apple entrypoints, no shell, and no inherited query archive. A compromise in the send helper must not grant arbitrary database or filesystem access.

## rollback and failure semantics

Apple Messages does not offer a reliable universal rollback after delivery. The product must never describe delete, unsend, or edit as guaranteed rollback.

The design needs explicit states for prepared, confirmed, submitted, accepted, delivered, failed, and indeterminate. Retries must be idempotent or require another confirmation when delivery state is uncertain.

## real-device gates

No send capability can ship from synthetic tests alone. Release candidates need isolated Apple Accounts and real-device coverage across direct and group iMessage, SMS/MMS forwarding, RCS availability, attachments, offline devices, permission revocation, duplicate prevention, and partial network failure.

Security review, accessibility review, abuse-case review, and a separately approved public disclosure are required before implementation can leave an experimental branch.
