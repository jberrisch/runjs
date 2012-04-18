
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <sys/socket.h>
#include <sys/time.h>
#include <sys/types.h>

//#define DEBUG 1

/* Kill the process when it doesn't output anything on its stdout for more */
/* than N seconds. */
#define READ_TIMEOUT 10

/* Make sure at least N seconds elapse before restarting a process. */
#define RESPAWN_MIN_INTERVAL 10

/* When fork() fails, retry after N seconds. */
#define FORK_RETRY_INTERVAL 10

/* stderr to monitor error passthrough */
#define ERR_SIZE 1024

static int err_fd = -1;
static volatile unsigned int child_exited = 0;


/* Sets the CLOEXEC flag on a file descriptor. Returns 0 on success, and -1 */
/* on failure. */
static int set_cloexec(int fd) {
  int flags;

  if ((flags = fcntl(fd, F_GETFD)) < 0)
    return -1;

  flags |= FD_CLOEXEC;

  if (fcntl(fd, F_SETFD, flags) < 0)
    return -1;

  return 0;
}


/* Like fprintf, but takes a file descriptor instead of a FILE struct. */
static int fdprintf(int fd, char* format, ...) {
  char buf[1024];
  int count;
  va_list argp;

  va_start(argp, format);
  count = vsnprintf(buf, sizeof buf, format, argp);
  va_end(argp);

  if (count > 0) {
    return write(fd, buf, count);
  } else {
    return 0;
  }
}


/* Exits the process due to a fatal error. Prints a custom message and an */
/* error message describing the current value of `errno`. */
static void fatal_error(char* message) {
  char* errmsg = strerror(errno);
  fdprintf(err_fd, "%s: %s\n", message, errmsg);
  exit(1);
}


static void sigchld_handler(int signal) {
  child_exited = ~0;
}


int main(int argc, char* argv[]) {
  int null_fd, alive_fd;
  pid_t watcher_pid;
  int root_pipe_fds[2], temp_fds[2];
  const struct timeval read_timeout = { tv_sec: READ_TIMEOUT, tv_usec: 0 };

  err_fd = STDERR_FILENO;

  /* Check arguments. */
  if (argc < 5 || strcmp("monitor", argv[3]) != 0) {
    fdprintf(err_fd, "Not enough arguments.\n"
                     "Usage: `runjswatch` node_bin run.js `monitor` args...\n");
    return 1;
  }

  /* Make sure we don't get blown up by SIGPIPE. */
  signal(SIGPIPE, SIG_IGN);

  /* Duplicate stderr so we can replace the original STDERR_FILENO. */
  err_fd = dup(err_fd);
  if (err_fd < 0)
    fatal_error("dup");
  if (set_cloexec(err_fd) < 0)
    fatal_error("set_cloexec");

  /* Dup /dev/null to stdin and stderr */
  null_fd = open("/dev/null", O_RDWR);
  if (null_fd < 0)
    fatal_error("open");
  if (dup2(null_fd, STDIN_FILENO) < 0)
    fatal_error("dup2");
  if (close(null_fd) < 0)
    fatal_error("close");

  /* Create a socket pair that will be supplied to the child process. The */
  /* child process is supposed to write something to its stderr at least once */
  /* every second, or it will be killed and restarted. */
  if (socketpair(AF_LOCAL, SOCK_STREAM, 0, temp_fds) < 0)
    fatal_error("socketpair");
  if (set_cloexec(temp_fds[0]) < 0)
    fatal_error("set_cloexec");
  if (dup2(temp_fds[1], STDOUT_FILENO) < 0)
    fatal_error("dup2");
  if (dup2(temp_fds[1], STDERR_FILENO) < 0)
    fatal_error("dup2");
  if (close(temp_fds[1]) < 0)
    fatal_error("close");
  alive_fd = temp_fds[0];

  /* Set the receive timeout for the alive fd to 1 second. */
  if (setsockopt(alive_fd,
                 SOL_SOCKET,
                 SO_RCVTIMEO,
                 (const void*) &read_timeout,
                 sizeof read_timeout) < 0)
    fatal_error("setsockopt");

  /* Create a pipe that will keep the root process alive until the watcher */
  /* daemon closes its end. Both ends should have CLOEXEC set because they */
  /* have no meaning to the exec'ed process. */
  if (pipe(root_pipe_fds) < 0)
    fatal_error("pipe");
  if (set_cloexec(root_pipe_fds[0]) < 0 || set_cloexec(root_pipe_fds[1]) < 0)
    fatal_error("set_cloexec");

  /* Fork for the first time. This splits off the root process from the */
  /* watcher daemon. */
  watcher_pid = fork(); 
  if (watcher_pid < 0)
    fatal_error("fork");

  if (watcher_pid > 0) {
    int r;
    char buf[16];

    /* We are the main process. Close the watcher end of the pipe. */
    if (close(root_pipe_fds[1]) < 0)
      fatal_error("close");

    /* Wait for the watcher process to close its end of the pipe. It will be */
    /* reported by read() returning 0 or EPIPE. The watcher will write "1" */
    /* if everything went well. Otherwise it will write other  stuff or just */
    /* close the pipe, depending on where the error happens. */
    r = read(root_pipe_fds[0], buf, sizeof buf);
    if (r != 1 || buf[0] != '1') {
      /* We didn't read "1". */
      return 1;
    }
    r = read(root_pipe_fds[0], buf, sizeof buf);
    if (!(r == 0 || errno == EPIPE)) {
      /* More stuff was written after "1". */
      return 1;
    }

    /* If we get here, the watcher daemon was started succesfully and it */
    /* successfully exec'ed once. */
    return 0;
  } else {
    pid_t child_pid;
    struct sigaction chld_action, chld_action_orig;

    /* We are the watcher daemon. Close the main process end of the pipe. */
   if (close(root_pipe_fds[0]) < 0)
      fatal_error("close");

    /* Make the watcher daemon session group leader. This can fail only if */
    /* this process already is the session group leader, so ignore any error. */
    setsid();

    /* Install a SIGCHLD handler. It should not restart any syscalls. */
    child_exited = 0;
    chld_action.sa_handler = sigchld_handler;
    sigemptyset (&chld_action.sa_mask);
    chld_action.sa_flags = SA_NOCLDSTOP;
    if (sigaction(SIGCHLD, &chld_action, &chld_action_orig) < 0) {
      fatal_error("sigaction");
    }

    /* Try to spawn for the first time. */
    child_pid = fork();
    if (child_pid < 0)
      fatal_error("fork");

    if (child_pid > 0) {
      /* We are still the watcher daemon. */
      time_t last_start_time = time(NULL);

      /* Close the error fd. */
#ifndef DEBUG
      if (close(err_fd) < 0) {
        write(root_pipe_fds[1], "x", 1);
        fatal_error("close");
      }
#endif

      /* Write 1 and close the signal pipe. If the child fork doesn't write */
      /* anything to the signal pipe, this will tell the root process that */
      /* exec() succeeded at least once. */
      write(root_pipe_fds[1], "1", 1);
      if (close(root_pipe_fds[1]) < 0) {
        write(root_pipe_fds[1], "x", 1);
        return 1;
      }

      /* Patch argv[3], replacing "monitor" by "restart" */
#define COMMAND "reload:"
      char arg_buf[ERR_SIZE + sizeof COMMAND] = COMMAND;
      argv[3] = arg_buf;
      char* buf = arg_buf + sizeof COMMAND - 1;
#undef COMMAND

      /* Run the main process watcher */
      for (;;) {
        int r, status, did_kill;
        time_t now;
        int offset = 0;
        memset(buf, 0, ERR_SIZE+1);
        do {
          /* Try to read from the alive socket. It has a timeout of 1 second. */
          r = recv(alive_fd, &buf[offset], ERR_SIZE - offset, 0);
          if(r > 0){
            offset += r;
            if(offset >= ERR_SIZE)
                offset = 0;
            }
        } while (r > 0);

        if (!child_exited) {
          kill(child_pid, SIGKILL);
          did_kill = 1;
#define KILLMSG "!! runjswatch:stdout/err dead, killed child !!"
          memcpy( (offset < ERR_SIZE - sizeof KILLMSG - 1) ? &buf[offset] : buf, KILLMSG, sizeof KILLMSG - 1);
#undef KILLMSG
        } else {
          did_kill = 0;
#define KILLMSG "!! runjswatch:child died all by itself !!"
          memcpy( (offset < ERR_SIZE - sizeof KILLMSG - 1) ? &buf[offset] : buf, KILLMSG, sizeof KILLMSG - 1);
#undef KILLMSG          
        }

        do {
          r = waitpid(child_pid, &status, 0);
        } while (r == -1 && errno == EINTR);

        if (r == -1) {
          /* Major fuckup. Exit. */
          return 1;
        }

        /* Check if the process actually exited with a good reason. */
        if (!did_kill &&
            ((WIFEXITED(status) && WEXITSTATUS(status) == 0) ||
            (WIFSIGNALED(status) && (WTERMSIG(status) == SIGKILL ||
                                     WTERMSIG(status) == SIGINT ||
                                     WTERMSIG(status) == SIGHUP)))) {
#ifdef DEBUG          
            fdprintf(err_fd, "Process exited cleanly, terminating watch %d %08x.\n",did_kill, status) ;
#endif                                               
          return 0;
        }

        /* If the previous child process exited too quickly, wait. */
        now = time(NULL);
        if (now == -1 || last_start_time == -1) {
          /* If either of the time() calls failed, sleep unconditionally */
          sleep(RESPAWN_MIN_INTERVAL);
        } else {
          time_t delta = now - last_start_time;
          if (delta >= 0 && delta < RESPAWN_MIN_INTERVAL) {
#ifdef DEBUG          
            fdprintf(err_fd, "Process exited too quickly, respawning after %d sec.\n", RESPAWN_MIN_INTERVAL - delta);
#endif                      
            sleep(RESPAWN_MIN_INTERVAL - delta);
          }
        }

        /* Restart the child process. */
        child_exited = 0;
        while ((child_pid = fork()) < 0) {
          /* On fork failure, retry after 10 seconds. */
          sleep(FORK_RETRY_INTERVAL);
        }

        if (child_pid == 0) {
          signal(SIGPIPE, SIG_DFL);
          sigaction(SIGCHLD, &chld_action_orig, NULL);

#ifdef DEBUG          
          fdprintf(err_fd, "Executing %s %s %s %s\n", argv[1], argv[2], argv[3], argv[4]);
#endif          
          execvp(argv[1], &argv[1]);
          return 1;
        }

        last_start_time = time(NULL);
      }

    } else {
      if (signal(SIGPIPE, SIG_DFL) < 0 ||
          sigaction(SIGCHLD, &chld_action_orig, NULL) < 0) {
        fdprintf(err_fd, "%s: %s\n", "signal", strerror(errno));
        write(root_pipe_fds[1], "x", 1);
        /* Return 0 here, otherwise the watcher daemon will try again. */
        return 0;
      }

      /* We are the child process. */
      execvp(argv[1], &argv[1]);

      /* If we get here then execvp has failed. Write the error to the stderr */
      /* and write some other stuff to the communications pipe to signal the */
      /* root process that something went wrong the first time we attempted */
      /* to exec. */
      fdprintf(err_fd, "%s: %s\n", "execvp", strerror(errno));
      write(root_pipe_fds[1], "x", 1);

      /* Return 0 here, otherwise the watcher daemon will try again. */
      return 0;
    }
  }
}
