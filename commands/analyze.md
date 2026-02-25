---
name: imessage:analyze
description: "Deep-dive any relationship"
---

## What This Does

Runs a comprehensive multi-tool analysis on your texting relationship with a specific contact. Covers message volume, initiation patterns, double-texting habits, response gaps, streaks, reactions, read receipts, and recent conversation history to paint a full picture of how you communicate.

## How To Use

Name a contact and ask to analyze the relationship. The analysis will automatically pull stats across multiple dimensions and synthesize them into a structured report.

## Tools Orchestrated

1. `contact_stats` -- Overall message counts, averages, and activity timeline
2. `who_initiates` -- Breakdown of who starts conversations
3. `double_texts` -- Patterns of back-to-back messaging without a reply
4. `streaks` -- Longest and current daily texting streaks
5. `conversation_gaps` -- Periods of silence and their durations
6. `get_reactions` -- Tapback and reaction usage patterns
7. `get_read_receipts` -- Read receipt behavior and response timing
8. `first_last_message` -- The very first and most recent messages exchanged

## Examples

- "Analyze my relationship with Alex"
- "Who texts first more often, me or Jordan?"
- "What is the longest streak I have had with my best friend?"
- "Show me the gaps in my conversation with Dad over the past year"

## Tips

- Works best when you name a specific contact -- broad analysis across all contacts is better suited for `imessage:wrapped`
- Combine with `imessage:search` to dig into specific moments flagged in the analysis
- Ask follow-up questions to zoom into any section of the report
- Great for understanding communication dynamics before and after major life events
