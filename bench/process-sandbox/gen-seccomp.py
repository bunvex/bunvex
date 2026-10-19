# STUDY-168: the sandbox's seccomp filter, compiled to BPF for `bwrap --seccomp` (needs python3-seccomp, Linux).
#   python3 bench/process-sandbox/gen-seccomp.py bench/process-sandbox/seccomp.bpf
# A deny list on top of the namespaces: syscalls an app never needs and that widen the kernel's attack surface
# (tracing, mounting, namespaces, kernel modules, BPF, keyrings, perf), and sockets other than AF_UNIX (the
# network namespace already has no interface but loopback; this keeps raw and packet sockets out too). Each fails
# with EPERM instead of killing the process, so the app sees an ordinary error.
import errno
import sys

import seccomp

DENY = [
    "ptrace", "process_vm_readv", "process_vm_writev", "kcmp", "pidfd_getfd",
    "mount", "umount2", "pivot_root", "chroot", "move_mount", "open_tree", "fsopen", "fsconfig", "fsmount",
    "fspick", "mount_setattr", "unshare", "setns",
    "kexec_load", "kexec_file_load", "init_module", "finit_module", "delete_module", "reboot", "swapon", "swapoff",
    "bpf", "perf_event_open", "userfaultfd", "keyctl", "add_key", "request_key",
    "syslog", "acct", "quotactl", "settimeofday", "clock_settime", "clock_adjtime", "adjtimex",
    "iopl", "ioperm", "open_by_handle_at", "name_to_handle_at", "lookup_dcookie", "vhangup",
    "personality",
]

f = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
for name in DENY:
    try:
        f.add_rule(seccomp.ERRNO(errno.EPERM), name)
    except Exception as e:  # a syscall this architecture lacks
        print(f"skip {name}: {e}", file=sys.stderr)
# socket(domain != AF_UNIX): no IP, raw or packet sockets.
f.add_rule(seccomp.ERRNO(errno.EPERM), "socket", seccomp.Arg(0, seccomp.NE, 1))
# clone/clone3 creating namespaces: CLONE_NEWUSER and friends are refused (clone3 cannot be filtered by flags,
# so it fails with ENOSYS and libc falls back to clone).
for flag in (0x10000000, 0x20000000, 0x40000000, 0x04000000, 0x08000000, 0x00020000, 0x02000000):
    f.add_rule(seccomp.ERRNO(errno.EPERM), "clone", seccomp.Arg(0, seccomp.MASKED_EQ, flag, flag))
f.add_rule(seccomp.ERRNO(errno.ENOSYS), "clone3")
with open(sys.argv[1], "wb") as out:
    f.export_bpf(out)
print(f"wrote {sys.argv[1]}")
