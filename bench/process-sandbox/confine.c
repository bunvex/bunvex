// STUDY-168: the sandbox without namespaces, for a container started with Docker's default options (no extra
// privilege). It runs before the child's runtime starts any thread, confines itself, then execs the child:
//   - Landlock (Linux 5.13+, unprivileged): file access only beneath the paths given; with ABI 4 (Linux 6.7+), no
//     TCP bind or connect at all;
//   - seccomp: the BPF deny list gen-seccomp.py writes (tracing, mounts, namespaces, BPF, non-Unix sockets, ...);
//   - RLIMIT_NPROC: a fork bomb stops at the limit (counted per uid, so each deployment gets its own uid);
//   - no_new_privs, which both of the above require and which keeps setuid binaries inert.
// The uid switch itself is `setpriv` (util-linux) in front of this program. All of it survives execve and applies
// to every thread the child starts later, which is why it cannot be done from inside the running Bun process.
//
//   confine --bpf FILE [--ro PATH]... [--rw PATH]... [--nproc N] [--no-landlock] -- PROGRAM ARGS...
// (--no-landlock exists for the study's sabotage runs only.)
//
// Build (static, so the sandbox needs no libc of its own): cc -O2 -static -o confine confine.c
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static void die(const char *what) {
  fprintf(stderr, "confine: %s: %s\n", what, strerror(errno));
  exit(127);
}

#define FS_READ (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define FS_FILE (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE)

static void allow(int ruleset, const char *path, __u64 access) {
  struct landlock_path_beneath_attr rule = {0};
  rule.parent_fd = open(path, O_PATH | O_CLOEXEC);
  if (rule.parent_fd < 0) die(path);
  struct stat st;
  if (fstat(rule.parent_fd, &st) < 0) die(path);
  // A rule on a file may only carry the rights that apply to files.
  rule.allowed_access = S_ISDIR(st.st_mode) ? access : access & (FS_FILE | LANDLOCK_ACCESS_FS_TRUNCATE);
  if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) < 0) die(path);
  close(rule.parent_fd);
}

int main(int argc, char **argv) {
  const char *bpf = NULL;
  long nproc = -1;
  int landlock = 1;
  int i = 1;
  // Pass 1: options other than paths (the ruleset is built once its ABI is known).
  for (int j = 1; j < argc && strcmp(argv[j], "--") != 0; j++) {
    if (!strcmp(argv[j], "--bpf")) bpf = argv[++j];
    else if (!strcmp(argv[j], "--nproc")) nproc = atol(argv[++j]);
    else if (!strcmp(argv[j], "--no-landlock")) landlock = 0;
    else if (!strcmp(argv[j], "--ro") || !strcmp(argv[j], "--rw")) j++;
  }

  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 1) die("landlock is not available");
  struct landlock_ruleset_attr attr = {0};
  attr.handled_access_fs = (LANDLOCK_ACCESS_FS_MAKE_SYM << 1) - 1; // every right of ABI 1
  if (abi >= 2) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) attr.handled_access_fs |= LANDLOCK_ACCESS_FS_TRUNCATE;
#ifdef LANDLOCK_ACCESS_NET_CONNECT_TCP
  // ABI 4: no rule for any port, so no TCP connect or bind at all.
  if (abi >= 4) attr.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_CONNECT_TCP;
#endif
  size_t attr_size = abi >= 4 ? sizeof(attr) : offsetof(struct landlock_ruleset_attr, handled_access_net);
  int ruleset = syscall(SYS_landlock_create_ruleset, &attr, attr_size, 0);
  if (ruleset < 0) die("landlock_create_ruleset");
  for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
    if (!strcmp(argv[i], "--ro")) allow(ruleset, argv[++i], FS_READ);
    else if (!strcmp(argv[i], "--rw")) allow(ruleset, argv[++i], attr.handled_access_fs);
    else if (!strcmp(argv[i], "--no-landlock")) continue;
    else if (!strcmp(argv[i], "--bpf") || !strcmp(argv[i], "--nproc")) i++;
  }
  if (i >= argc - 1) {
    fprintf(stderr, "usage: confine --bpf FILE [--ro PATH]... [--rw PATH]... [--nproc N] -- PROGRAM ARGS...\n");
    return 2;
  }

  // Read the filter before Landlock hides its file.
  struct sock_filter filter[4096];
  unsigned short len = 0;
  if (bpf) {
    int fd = open(bpf, O_RDONLY | O_CLOEXEC);
    if (fd < 0) die(bpf);
    ssize_t n = read(fd, filter, sizeof(filter));
    if (n <= 0 || n % sizeof(struct sock_filter) != 0) die("reading the seccomp filter");
    len = n / sizeof(struct sock_filter);
    close(fd);
  }
  if (nproc >= 0) {
    struct rlimit rl = {nproc, nproc};
    if (setrlimit(RLIMIT_NPROC, &rl) < 0) die("RLIMIT_NPROC");
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) die("no_new_privs");
  if (landlock && syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) die("landlock_restrict_self");
  close(ruleset);
  if (len) {
    struct sock_fprog prog = {len, filter};
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) < 0) die("seccomp");
  }
  execv(argv[i + 1], &argv[i + 1]);
  die(argv[i + 1]);
}
