---
"@bunvex/client": patch
---

The client warns about large and slow transitions, as Convex's `reportLargeTransition`. It logs a frame over 20 MB, or else a transition that took more than 20 s to arrive. The transit is measured from the `clientClockSkew` and `serverTs` the server sends, and a verbose line is always logged (STUDY-103; "more than" for Convex's "more that", DV-349).
