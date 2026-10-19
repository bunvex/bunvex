---
"@bunvex/server": patch
"@bunvex/cli": patch
---

`bunvex-local-backend` and its `keygen admin-key` read the instance secret from `INSTANCE_SECRET` when
`--instance-secret` is absent (the flag still wins), and `bunvex dev` and the Docker image pass it there instead
of on the command line, which every user of the machine can read (DV-525, STUDY-170).
