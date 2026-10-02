---
name: Deriv quote precision
description: How Deriv's numeric quotes and pip_size affect last-digit extraction.
---

Deriv's public API sends quotes as JSON numbers, so trailing zeroes can be omitted from the raw numeric token even when the market precision includes them (for example, `9636.4` with `pip_size` 2). Preserve the quote's numeric value and append only missing fractional zeroes to the `pip_size` before extracting the last character. Never round or truncate the quote, and do not use a Deriv-provided last-digit field.

**Why:** Taking the last character of an unformatted JSON number misses zero digits and skews the digit distribution.

**How to apply:** Use `tick.pip_size` for live data and the history response's `pip_size` for historical prices. Keep numeric conversion separate for chart values and trend comparisons.