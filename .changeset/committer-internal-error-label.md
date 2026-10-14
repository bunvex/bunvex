---
"@bunvex/core": patch
---

An internal error inside the committer's drain (a commit's `atTs` throwing, say) stops it with "the committer stopped after an internal error: …" instead of "… after a persistence failure: …", and `persistenceFailure` is false. A new `CommitterInternalError` is the cause; `CommitListenerError` extends it. A failing store, flush or lease still says "persistence failure".
