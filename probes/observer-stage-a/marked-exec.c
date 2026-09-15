#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MARKER_OFFSET_BIAS ((off_t)0x5a170000)

static void usage(const char *program) {
    fprintf(stderr, "usage: %s <marker-file> <command> [args...]\n", program);
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

    execv(argv[2], &argv[2]);
    fprintf(stderr, "exec failed: %s\n", strerror(errno));
    close(marker_fd);
    return 127;
}
