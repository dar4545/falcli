# 03 — Account usage overview

**What to build:** A compact account area that shows the user's remaining FAL credits, current-month spend, and recent daily usage without turning the workspace into a full billing dashboard.

**Blocked by:** 01 — Local workspace shell and test seam.

**Status:** resolved

**Implemented:** 2026-07-27

- [ ] The header loads the authenticated FAL account name and remaining credit balance at startup.
- [ ] The account area calculates and shows current-month spend from FAL usage data.
- [ ] A compact chart shows daily spend for the latest seven days.
- [ ] A manual refresh action reloads both billing and usage data.
- [ ] The time of the last successful refresh is visible.
- [ ] A failed refresh retains the last successful values and marks them as stale.
- [ ] A missing or non-Admin FAL key produces an actionable account-panel error without disabling generation.
- [ ] Empty usage periods render as zero usage rather than an error.
- [ ] Dates and month boundaries use an explicit, consistent timezone interpretation.
- [ ] End-to-end tests cover successful responses, empty usage, Admin-scope failure, rate limiting, stale-value retention, and month/seven-day aggregation.
