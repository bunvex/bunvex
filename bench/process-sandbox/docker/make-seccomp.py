# STUDY-168: Docker's default seccomp profile plus the syscalls bubblewrap needs inside a container without
# CAP_SYS_ADMIN (namespaces, its own mounts, pivot_root, the sandbox's hostname).
#   curl -fsSL https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json -o moby-default-seccomp.json
#   python3 make-seccomp.py moby-default-seccomp.json seccomp-bwrap.json
import json
import sys

profile = json.load(open(sys.argv[1]))
profile["syscalls"].insert(
    0,
    {
        "names": ["clone", "unshare", "setns", "mount", "umount2", "pivot_root", "sethostname"],
        "action": "SCMP_ACT_ALLOW",
        "comment": "STUDY-168: bubblewrap inside the container",
    },
)
json.dump(profile, open(sys.argv[2], "w"), indent=1)
