#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <pty.h>

#define MARKER_OFFSET_BIAS ((off_t)0x5a170000)

static volatile sig_atomic_t child_pid = -1;

static void forward_signal(int signal_number) {
    if (child_pid > 0) {
        kill((pid_t)child_pid, signal_number);
    }
}

static void usage(const char *program) {
    fprintf(stderr, "usage: %s <marker-file> <command> [args...]\n", program);
}

static void linger_for_retention_control(void) {
    if (getenv("ZYLOS_PTY_MARKER_TEST_LINGER_WRAPPER") != NULL) {
        for (;;) pause();
    }
}

int main(int argc, char **argv) {
    if (argc < 3) {
        usage(argv[0]);
        return 64;
    }

    int marker_fd = open(argv[1], O_RDONLY);
    if (marker_fd < 0) {
        fprintf(stderr, "open marker failed: %s\n", strerror(errno));
        return 2;
    }
    int flags = fcntl(marker_fd, F_GETFD);
    if (flags < 0 || fcntl(marker_fd, F_SETFD, flags & ~FD_CLOEXEC) != 0) {
        fprintf(stderr, "clear marker FD_CLOEXEC failed: %s\n", strerror(errno));
        close(marker_fd);
        return 2;
    }
    struct stat marker_stat;
    if (fstat(marker_fd, &marker_stat) != 0) {
        fprintf(stderr, "stat marker failed: %s\n", strerror(errno));
        close(marker_fd);
        return 2;
    }
    off_t marker_position = MARKER_OFFSET_BIAS + (off_t)(marker_stat.st_ino & 0xfffff);
    if (lseek(marker_fd, marker_position, SEEK_SET) != marker_position) {
        fprintf(stderr, "prime marker offset failed: %s\n", strerror(errno));
        close(marker_fd);
        return 2;
    }
    if (setenv("ZYLOS_OBSERVER_MARKER_FILE", argv[1], 1) != 0) {
        fprintf(stderr, "set marker environment failed: %s\n", strerror(errno));
        close(marker_fd);
        return 2;
    }

    struct winsize size = {
        .ws_row = 24,
        .ws_col = 80,
        .ws_xpixel = 0,
        .ws_ypixel = 0,
    };
    struct termios terminal;
    if (tcgetattr(STDIN_FILENO, &terminal) != 0) {
        memset(&terminal, 0, sizeof(terminal));
        cfmakeraw(&terminal);
        terminal.c_cflag |= CREAD | CS8;
        terminal.c_cc[VMIN] = 1;
        terminal.c_cc[VTIME] = 0;
        cfsetispeed(&terminal, B38400);
        cfsetospeed(&terminal, B38400);
    }
    int master_fd = -1;
    pid_t pid = forkpty(&master_fd, NULL, &terminal, &size);
    if (pid < 0) {
        fprintf(stderr, "forkpty failed: %s\n", strerror(errno));
        close(marker_fd);
        return 2;
    }
    if (pid == 0) {
        execv(argv[2], &argv[2]);
        fprintf(stderr, "exec failed: %s\n", strerror(errno));
        _exit(127);
    }

    child_pid = pid;
    signal(SIGTERM, forward_signal);
    signal(SIGINT, forward_signal);
    signal(SIGHUP, forward_signal);
    /* Keep the marker descriptor in the wrapper as well as the child.  The
       wrapper is part of the owned topology and must remain discoverable even
       after its child daemonizes or reparents. */
    if (getenv("ZYLOS_PTY_MARKER_TEST_CLOSE_WRAPPER") != NULL) {
        close(marker_fd);
        marker_fd = -1;
    }

    char buffer[8192];
    char last_output[8192];
    ssize_t last_output_size = 0;
    for (;;) {
        struct pollfd descriptor = {.fd = master_fd, .events = POLLIN | POLLHUP};
        int poll_result = poll(&descriptor, 1, 250);
        if (poll_result < 0 && errno != EINTR) {
            break;
        }
        if (poll_result > 0 && (descriptor.revents & POLLIN)) {
            ssize_t read_result = read(master_fd, buffer, sizeof(buffer));
            if (read_result > 0) {
                last_output_size = read_result;
                memcpy(last_output, buffer, (size_t)read_result);
            }
            if (read_result <= 0 && errno != EINTR) {
                break;
            }
        }
        if (poll_result > 0 && (descriptor.revents & (POLLHUP | POLLERR | POLLNVAL))) {
            break;
        }
        int status = 0;
        pid_t wait_result = waitpid(pid, &status, WNOHANG);
        if (wait_result == pid) {
            close(master_fd);
            linger_for_retention_control();
            if (marker_fd >= 0) close(marker_fd);
            if (WIFEXITED(status)) {
                int exit_code = WEXITSTATUS(status);
                if (exit_code != 0 && last_output_size > 0) {
                    write(STDERR_FILENO, last_output, (size_t)last_output_size);
                }
                return exit_code;
            }
            if (WIFSIGNALED(status)) {
                if (last_output_size > 0) write(STDERR_FILENO, last_output, (size_t)last_output_size);
                return 128 + WTERMSIG(status);
            }
            return 1;
        }
    }

    close(master_fd);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    linger_for_retention_control();
    if (marker_fd >= 0) close(marker_fd);
    if (WIFEXITED(status)) {
        int exit_code = WEXITSTATUS(status);
        if (exit_code != 0 && last_output_size > 0) write(STDERR_FILENO, last_output, (size_t)last_output_size);
        return exit_code;
    }
    if (WIFSIGNALED(status)) {
        if (last_output_size > 0) write(STDERR_FILENO, last_output, (size_t)last_output_size);
        return 128 + WTERMSIG(status);
    }
    return 1;
}
