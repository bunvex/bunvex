---
"@bunvex/core": patch
"@bunvex/server": patch
---

A commit listener that throws still stops the committer (fail-stop), but is no longer reported as a persistence failure: the `CommitterStoppedError` reads "the committer stopped after an internal error in commit listener "<name>": …", its cause is a new `CommitListenerError` naming the listener (`onCommit(fn, name)`; the server's are named) with the original error as its cause, and `persistenceFailure` is false. The commits of the batch being published, which are durable and visible, are acknowledged instead of left hanging; later ones are refused.
