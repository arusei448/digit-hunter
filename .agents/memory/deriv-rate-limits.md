---
name: Deriv API rate-limit recovery
description: Recovery patterns for rate-limited history requests and live tick subscriptions on Deriv's public WebSocket.
---

When `ticks_history` is rejected, keep history failure separate from live-stream health: continue with cached or empty history when the socket is open, reuse cached history on reconnect, and group multi-symbol tick subscriptions. Do not reset reconnect backoff just because the WebSocket opened; reset it only after receiving a valid tick. Handle rejected tick subscriptions explicitly so exponential backoff can recover them.

**Why:** the published dashboard entered a rapid reconnect loop after Deriv rate-limited history requests. Deriv documents shared WebSocket request budgets and recommends pacing requests and backing off after rejection.

**How to apply:** use these rules whenever changing initialization, history loading, market switching, or reconnect behavior for the Deriv public WebSocket.
