---
name: Deriv tick identifiers
description: Observed behavior of the Deriv public WebSocket tick id field.
---

In the current Deriv public tick stream, `tick.id` remains the same across successive tick updates while quote and timestamp change. Treat it as a stream/subscription identifier, not as a unique identifier for each tick.

**Why:** Deduplicating Rise & Fall events by `tick.id` caused all updates after the first to be discarded, leaving the display stagnant.

**How to apply:** Never deduplicate live tick messages solely by `tick.id`. If deduplication is needed, use a confirmed per-tick identity or a carefully scoped composite key.
