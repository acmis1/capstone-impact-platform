#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static int apply_boundary(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    fputs("credential boundary: could not disable process dumping\n", stderr);
    return 126;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
    fputs("credential boundary: could not set no_new_privs\n", stderr);
    return 126;
  }
  return 0;
}

#ifdef CAPSTONE_CREDENTIAL_BOUNDARY_PRELOAD
__attribute__((constructor)) static void apply_boundary_after_exec(void) {
  if (apply_boundary() != 0) _exit(126);
}
#else
static int self_test(void) {
  pid_t child = fork();
  if (child < 0) {
    fputs("credential boundary: self-test fork failed\n", stderr);
    return 126;
  }
  if (child == 0) {
    char path[64];
    int length = snprintf(path, sizeof(path), "/proc/%ld/environ", (long)getppid());
    if (length < 1 || (size_t)length >= sizeof(path)) _exit(126);
    int descriptor = open(path, O_RDONLY | O_CLOEXEC);
    if (descriptor >= 0) {
      close(descriptor);
      _exit(1);
    }
    _exit(errno == EACCES || errno == EPERM ? 0 : 126);
  }

  int status = 0;
  if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) {
    fputs("credential boundary: self-test child failed\n", stderr);
    return 126;
  }
  if (WEXITSTATUS(status) != 0) {
    fputs("credential boundary: parent environment remained readable\n", stderr);
    return WEXITSTATUS(status) == 1 ? 1 : 126;
  }
  puts("credential boundary self-test passed");
  return 0;
}

int main(int argc, char **argv) {
  int boundary_status = apply_boundary();
  if (boundary_status != 0) return boundary_status;

  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc < 2) {
    fputs("credential boundary: missing command\n", stderr);
    return 126;
  }

  execvp(argv[1], &argv[1]);
  fputs("credential boundary: command launch failed\n", stderr);
  return 126;
}
#endif
