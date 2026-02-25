#!/usr/bin/env node
// Generate README screenshots using Playwright
// Usage: node scripts/screenshots.mjs

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

// ── Capture real command output ────────────────────────────────────
function run(cmd, args = [], timeout = 15_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout }).trim();
  } catch (e) {
    return e.stdout?.trim() || e.message;
  }
}

function ansiToHtml(str) {
  let html = str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Green ✓
  html = html.replace(/\x1b\[32m(.*?)\x1b\[0m/g, '<span style="color:#a6e3a1">$1</span>');
  // Red ✗
  html = html.replace(/\x1b\[31m(.*?)\x1b\[0m/g, '<span style="color:#f38ba8">$1</span>');
  // Yellow !
  html = html.replace(/\x1b\[33m(.*?)\x1b\[0m/g, '<span style="color:#f9e2af">$1</span>');
  // Clean remaining ANSI
  html = html.replace(/\x1b\[[0-9;]*m/g, "");

  return html;
}

// ── HTML terminal template ─────────────────────────────────────────
function terminalHtml(lines, { title = "Terminal", theme = "dark", width = 700 } = {}) {
  const isDark = theme === "dark";
  const bg = isDark ? "#1e1e2e" : "#eff1f5";
  const fg = isDark ? "#cdd6f4" : "#4c4f69";
  const titleBg = isDark ? "#313244" : "#dce0e8";
  const green = isDark ? "#a6e3a1" : "#40a02b";
  const muted = isDark ? "#6c7086" : "#9ca0b0";

  // For light theme, swap colors in the HTML content
  let content = lines;
  if (!isDark) {
    content = content
      .replace(/#a6e3a1/g, "#40a02b")
      .replace(/#f38ba8/g, "#d20f39")
      .replace(/#f9e2af/g, "#df8e1d")
      .replace(/#6c7086/g, "#9ca0b0");
  }

  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Menlo", monospace;
  }
  .window {
    background: ${bg};
    border-radius: 12px;
    width: ${width}px;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,${isDark ? "0.5" : "0.15"});
  }
  .titlebar {
    background: ${titleBg};
    padding: 12px 16px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title {
    color: ${isDark ? "#a6adc8" : "#6c6f85"};
    font-size: 12px;
    margin-left: 8px;
  }
  .content {
    padding: 20px;
    color: ${fg};
    font-size: 13px;
    line-height: 1.65;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .prompt { color: ${green}; }
  .cmd { color: ${fg}; font-weight: 600; }
  .muted { color: ${muted}; }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <div class="dot" style="background:#f38ba8"></div>
    <div class="dot" style="background:#f9e2af"></div>
    <div class="dot" style="background:#a6e3a1"></div>
    <span class="title">${title}</span>
  </div>
  <div class="content">${content}</div>
</div>
</body>
</html>`;
}

// ── Generate screenshots ───────────────────────────────────────────
async function main() {
  mkdirSync("assets", { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 2 });

  async function screenshot(html, filename) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.setContent(html);
    // Wait for fonts
    await page.waitForTimeout(500);
    const el = page.locator(".window");
    await el.screenshot({ path: `assets/${filename}`, type: "png" });
    await page.close();
    console.log(`  ✓ assets/${filename}`);
  }

  console.log("\nGenerating screenshots...\n");

  // ── 1. Doctor output ──────────────────────────────────────────
  const doctorRaw = run("node", ["bin/imessage-mcp.js", "doctor"]);
  const doctorHtml = ansiToHtml(doctorRaw);

  for (const theme of ["dark", "light"]) {
    await screenshot(
      terminalHtml(
        `<span class="prompt">$</span> <span class="cmd">npx imessage-mcp doctor</span>\n\n${doctorHtml}`,
        { title: "~/Code/my-project", theme, width: 680 }
      ),
      `doctor-${theme}.png`
    );
  }

  // ── 2. Hero demo — emoji reactions ────────────────────────────
  // Run the actual query
  console.log("  ⏳ Running Claude query for demo screenshot...");
  const emojiRaw = run("claude", [
    "-p", "--dangerously-skip-permissions", "--max-turns", "4",
    "what are my top 5 emoji reactions in imessage? keep it short, use a markdown table"
  ], 60_000);

  if (emojiRaw && !emojiRaw.includes("Error") && !emojiRaw.includes("Reached max turns")) {
    const cleaned = emojiRaw
      .replace(/\*\*(.*?)\*\*/g, "$1")
      .replace(/^#+\s*/gm, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    for (const theme of ["dark", "light"]) {
      await screenshot(
        terminalHtml(
          `<span class="prompt">&gt;</span> <span class="cmd">what are my top 5 emoji reactions in imessage?</span>\n\n${cleaned}`,
          { title: "Claude Code — imessage-mcp", theme, width: 720 }
        ),
        `demo-${theme}.png`
      );
    }
  } else {
    console.log("  ⚠ Claude query failed, using static demo content");
    const staticDemo = `Your top 5 tapback reactions across 2,160 total:

| # | Reaction      | Count | Vibe                          |
|---|---------------|-------|-------------------------------|
| 1 | ❤️ Love       | 1,299 | You're a lover, not a fighter |
| 2 | 👍 Like       |   342 | The classic acknowledgment    |
| 3 | ‼️ Emphasize  |   295 | "THIS." energy                |
| 4 | 😂 Laugh      |   131 | Reserved for the actually funny|
| 5 | 👎 Dislike    |    81 | Sometimes people are wrong    |

60% of your reactions are hearts — overwhelmingly positive.`;

    for (const theme of ["dark", "light"]) {
      const escaped = staticDemo.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      await screenshot(
        terminalHtml(
          `<span class="prompt">&gt;</span> <span class="cmd">what are my top 5 emoji reactions in imessage?</span>\n\n${escaped}`,
          { title: "Claude Code — imessage-mcp", theme, width: 720 }
        ),
        `demo-${theme}.png`
      );
    }
  }

  // ── 3. Safe Mode ──────────────────────────────────────────────
  const safeContent = `<span class="prompt">$</span> <span class="cmd">IMESSAGE_SAFE_MODE=1 claude -p 'show my last 3 messages'</span>

Messages (3 results):

  2026-02-24 11:32 PM  sent      [REDACTED - safe mode]
  2026-02-24 11:30 PM  received  [REDACTED - safe mode]
  2026-02-24 11:28 PM  sent      [REDACTED - safe mode]

<span class="muted">All message bodies redacted. Only metadata returned.</span>`;

  for (const theme of ["dark", "light"]) {
    await screenshot(
      terminalHtml(safeContent, { title: "Safe Mode", theme, width: 620 }),
      `safe-mode-${theme}.png`
    );
  }

  // ── 4. Setup ──────────────────────────────────────────────────
  const setupContent = `<span class="muted"># Install</span>
<span class="prompt">$</span> <span class="cmd">npm install -g imessage-mcp</span>

<span class="muted"># Add to Claude Code</span>
<span class="prompt">$</span> <span class="cmd">claude mcp add imessage -- npx -y imessage-mcp</span>

<span class="muted"># Or add to any MCP client's JSON config:</span>
{
  "mcpServers": {
    "imessage": {
      "command": "npx",
      "args": ["-y", "imessage-mcp"]
    }
  }
}`;

  await screenshot(
    terminalHtml(setupContent, { title: "Setup", theme: "dark", width: 560 }),
    "setup-dark.png"
  );

  // ── 5. Tools overview ─────────────────────────────────────────
  const toolsContent = `<span class="cmd">25 tools</span> across 9 categories — all read-only

  Messages     search_messages, get_conversation
  Contacts     list_contacts, get_contact, resolve_contact
  Analytics    message_stats, contact_stats, temporal_heatmap
  Memories     on_this_day, first_last_message
  Patterns     who_initiates, streaks, double_texts,
               conversation_gaps, forgotten_contacts
  Wrapped      yearly_wrapped
  Groups       list_group_chats, get_group_chat
  Media        list_attachments
  Social       get_reactions, get_read_receipts, get_thread,
               get_edited_messages, get_message_effects
  System       help`;

  await screenshot(
    terminalHtml(toolsContent, { title: "Tools", theme: "dark", width: 600 }),
    "tools-dark.png"
  );

  await browser.close();
  console.log("\nDone!\n");
}

main().catch(console.error);
