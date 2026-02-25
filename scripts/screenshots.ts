#!/usr/bin/env tsx
// Generate README screenshots using Playwright
// Usage: npx tsx scripts/screenshots.ts

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

// ── Capture real command output ────────────────────────────────────
function run(cmd: string, args: string[] = [], timeout = 15_000): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf-8", timeout }).trim();
  } catch (e: any) {
    return e.stdout?.trim() || e.message;
  }
}

function ansiToHtml(str: string): string {
  let html = str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Green checkmark
  html = html.replace(/\x1b\[32m(.*?)\x1b\[0m/g, '<span style="color:#a6e3a1">$1</span>');
  // Red X
  html = html.replace(/\x1b\[31m(.*?)\x1b\[0m/g, '<span style="color:#f38ba8">$1</span>');
  // Yellow !
  html = html.replace(/\x1b\[33m(.*?)\x1b\[0m/g, '<span style="color:#f9e2af">$1</span>');
  // Clean remaining ANSI
  html = html.replace(/\x1b\[[0-9;]*m/g, "");

  return html;
}

// ── HTML terminal template ─────────────────────────────────────────
function terminalHtml(lines: string, { title = "Terminal", theme = "dark" } = {}): string {
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
    background: ${bg};
    font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Menlo", monospace;
  }
  .window {
    background: ${bg};
    width: 100%;
    overflow: hidden;
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
    padding: 24px;
    color: ${fg};
    font-size: 13.5px;
    line-height: 1.7;
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

  async function screenshot(html: string, filename: string) {
    const page = await context.newPage();
    await page.setViewportSize({ width: 880, height: 800 });
    await page.setContent(html);
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
        { title: "~/Code/my-project", theme }
      ),
      `doctor-${theme}.png`
    );
  }

  // ── 2. Hero demo — emoji reactions ────────────────────────────
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
          { title: "Claude Code — imessage-mcp", theme }
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
          { title: "Claude Code — imessage-mcp", theme }
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
      terminalHtml(safeContent, { title: "Safe Mode", theme }),
      `safe-mode-${theme}.png`
    );
  }

  // ── 4. Wrapped — year-in-review ───────────────────────────────
  const wrappedContent = `<span class="prompt">&gt;</span> <span class="cmd">give me my 2025 imessage wrapped</span>

Your 2025 iMessage Wrapped

  Total messages       28,441
  Contacts             86
  Busiest month        October (3,847 messages)
  Most active hour     10 PM
  Top contact          Best Friend (4,201 messages)

  Longest streak       142 days (Mar 3 — Jul 23)
  Most-used reaction   ❤️ Love (1,299 times)
  Group chats          12 active

  You sent first       62% of the time
  Avg response time    4 minutes

<span class="muted">You texted across 312 of 365 days. That's 85% of the year.</span>`;

  for (const theme of ["dark", "light"]) {
    await screenshot(
      terminalHtml(wrappedContent, { title: "Claude Code — imessage-mcp", theme }),
      `wrapped-${theme}.png`
    );
  }

  await browser.close();
  console.log("\nDone!\n");
}

main().catch(console.error);
