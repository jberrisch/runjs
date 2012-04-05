#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

void set_cloexec(int fd) {
  int flags;

  if ((flags = fcntl(fd, F_GETFD)) < 0) {
    perror("fcntl");
    exit(1);
  }

  flags |= FD_CLOEXEC;

  if (fcntl(fd, F_SETFD, flags) < 0) {
    perror("fcntl");
    exit(1);
  }
}

void fperror(int fd, char* message) {
  char buf[1024];
  char* errmsg = strerror(errno);
  int count;
  
  count = snprintf(buf, sizeof(buf), "%s: %s\n", message, errmsg);
  if (count > 0)
    write(fd, buf, count);
 
  exit(1);
}


int main(int argc, char* argv[]) {
  int out_fd, err_fd, null_fd, pid;
  
  if (argc < 2) {
    fprintf(stderr, "Not enough arguments. Usage: `daemonize` command...\n");
    return 1;
  }

  out_fd = dup(1);
  if (out_fd < 0)
    fperror(2, "dup");
  set_cloexec(out_fd);

  err_fd = dup(2);
  if (err_fd < 0)
    fperror(2, "dup");
  set_cloexec(err_fd);
  
  null_fd = open("/dev/null", O_RDWR);
  if (null_fd < 0)
    fperror(err_fd, "open");
  set_cloexec(null_fd);
  
  if (dup2(null_fd, 0) < 0)
    fperror(err_fd, "dup2");
  if (dup2(null_fd, 1) < 0)
    fperror(err_fd, "dup2");
  if (dup2(null_fd, 2) < 0)
    fperror(err_fd, "dup2");
  
  pid = fork();
  if (pid < 0)
    fperror(err_fd, "fork");
  
  if (pid == 0) {
    /* Child process */
    setsid();
    execvp(argv[1], &argv[1]);
    fperror(err_fd, "execvp");
    return 1;
  }
    
  /* Ugly, but typically works :-) */
  if (dup2(out_fd, 1) < 0)
    fperror(err_fd, "dup2");
  fprintf(stdout, "pid: %d\n", pid);
  
  return 0;
}
