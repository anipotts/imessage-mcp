# real demo runbook

This runbook produces public release media without retaining private Messages values in the repository.

## preflight

1. Use a clean `messages-demo` directory and an isolated MCP configuration containing only `imessage-history`.
2. Authenticate Claude Code normally. Never show or record credentials.
3. Confirm Ghostty has Full Disk Access and OBS has Screen Recording permission.
4. Enable Focus, hide notification previews, close unrelated windows, and clear terminal scrollback.
5. Select one consented direct conversation through a bounded recent-history review. Exclude sensitive topics, third parties, URLs, attachments, commands, and precise private locations.
6. Use first name only. Keep MCP payloads collapsed.

## recordings

### hero

Submit the complete visible prompt:

> Search my Messages with [first name] and summarize the latest plan we made. Include every concrete detail and keep it to three bullets.

Trim from the Enter key through one second after the final streamed line. Target 18–30 seconds.

### setup

Show Node, secret-file environment variables without their values, privacy-first `doctor`, exact `claude mcp add imessage-history`, `claude mcp list`, and one redacted `server_status`. Target 35–60 seconds.

### live sync

Initialize `sync_messages` from `latest`. After the consented contact sends one public-safe message, submit:

> Check Messages again and tell me only what changed since the last sync.

The result must say that the incoming change was observed, never sent by the MCP.

### analytics

Submit:

> Analyze my Messages with [first name] over the last 90 days. Show total messages, who starts conversations more often, and median response time. Keep it to three bullets.

Require `message_count`, `initiation`, and `response_time` results grounded in the structured date, timezone, formula, and service scope.

## encoding

- Capture the Ghostty window only at Retina resolution with no audio.
- Hero: 1280x800 GIF, 12–15 fps, under 9.5 MB.
- Other clips: 1440x900 H.264, 30 fps, `yuv420p`, fast-start, under 10 MB each.
- Run the automated OCR-sensitive-data scan and a manual frame review at original resolution.
- Create and verify `demo-evidence.json` with `scripts/demo-evidence.ts`.
- Upload only the four delivery files and evidence to the versioned draft GitHub release.
- After immutable public verification, move raw task-owned captures to Trash.
