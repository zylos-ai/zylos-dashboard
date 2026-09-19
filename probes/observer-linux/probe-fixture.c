#define _GNU_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <errno.h>
#include <dirent.h>
#ifdef __linux__
#include <sys/syscall.h>
#endif

static int cleanup(const char *pid_text, const char *ticks) {
#ifdef __linux__
    char *end = NULL;
    long parsed = strtol(pid_text, &end, 10);
    if (!end || *end || parsed <= 1 || parsed > 2147483647L) return 64;
    int fd = (int)syscall(SYS_pidfd_open, (pid_t)parsed, 0);
    if (fd < 0) return errno == ESRCH ? 0 : 5;
    char directory[80], filename[80], line[4096];
    snprintf(directory, sizeof(directory), "/proc/%ld", parsed);
    snprintf(filename, sizeof(filename), "/proc/%ld/stat", parsed);
    struct stat info;
    /* The stat file can become root-owned after exit_mm, before reaping.
       Check the process directory, as the harness does; retain pidfd pinning
       and the start-tick check below before any signal. */
    if (stat(directory, &info) != 0) {
        int error = errno;
        close(fd);
        return error == ENOENT || error == ESRCH ? 0 : 5;
    }
    if (info.st_uid != getuid()) { close(fd); return 5; }
    FILE *input = fopen(filename, "r");
    if (!input) {
        int error = errno;
        close(fd);
        return error == ENOENT || error == ESRCH ? 0 : 5;
    }
    errno = 0;
    char *read = fgets(line, sizeof(line), input);
    int read_error = errno;
    fclose(input);
    if (!read && (read_error == ENOENT || read_error == ESRCH)) { close(fd); return 0; }
    char *tail = read ? strrchr(line, ')') : NULL;
    if (!tail || tail[1] != ' ') { close(fd); return 5; }
    char *save = NULL, *token = strtok_r(tail + 2, " \n", &save);
    int field = 3;
    while (token && field < 22) { token = strtok_r(NULL, " \n", &save); field++; }
    if (!token || strcmp(token, ticks) != 0) { close(fd); return 4; }
    int result = (int)syscall(SYS_pidfd_send_signal, fd, SIGKILL, NULL, 0);
    int error = errno;
    close(fd);
    return result == 0 || error == ESRCH ? 0 : 5;
#else
    (void)pid_text; (void)ticks;
    return 64;
#endif
}

static int report_pid(const char *filename) {
    int report = open(filename, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (report < 0) return 2;
    int count = dprintf(report, "%ld\n", (long)getpid());
    int closed = close(report);
    return count > 0 && closed == 0 ? 0 : 2;
}

static int close_marker_fds(const char *marker) {
    struct stat target;
    if (stat(marker, &target) != 0) return 2;
    DIR *directory = opendir("/proc/self/fd");
    if (!directory) return 2;
    struct dirent *entry;
    int count = 0;
    while ((entry = readdir(directory))) {
        char *end = NULL;
        long number = strtol(entry->d_name, &end, 10);
        if (!end || end == entry->d_name || *end || number < 3 || number > 2147483647L) continue;
        int fd = (int)number;
        if (fd == dirfd(directory)) continue;
        struct stat info;
        if (fstat(fd, &info) != 0) { closedir(directory); return 2; }
        if (info.st_dev == target.st_dev && info.st_ino == target.st_ino) {
            if (close(fd) != 0) { closedir(directory); return 2; }
            count++;
        }
    }
    closedir(directory);
    return count > 0 ? 0 : 2;
}

/* Only the final daemon writes readiness; both intermediate processes exit. */
int main(int argc, char **argv) {
    if (argc != 4) return 64;
    if (strcmp(argv[1], "cleanup") == 0) return cleanup(argv[2], argv[3]);
    if (strcmp(argv[1], "daemon") == 0) {
        pid_t first = fork();
        if (first < 0) return 2;
        if (first > 0) { int status; return waitpid(first, &status, 0) < 0 ? 2 : 0; }
        if (setsid() < 0) _exit(2);
        pid_t second = fork();
        if (second < 0) _exit(2);
        if (second > 0) _exit(0);
    } else if (strcmp(argv[1], "family") == 0) {
        /* Parent retains the marker. Child must require descendant closure. */
        signal(SIGTERM, SIG_IGN);
        pid_t child = fork();
        if (child < 0) return 2;
        if (child == 0) {
            if (close_marker_fds(argv[3]) != 0) _exit(2);
            char report[4096];
            int size = snprintf(report, sizeof(report), "%s.child", argv[2]);
            if (size < 0 || (size_t)size >= sizeof(report) || report_pid(report) != 0) _exit(2);
            alarm(45);
            for (;;) pause();
        }
    } else if (strcmp(argv[1], "reader") == 0) {
        /* Same inode as ownership marker, deliberately offset zero. */
        if (open(argv[3], O_RDONLY) < 0) return 2;
    } else if (strcmp(argv[1], "sentinel") != 0) return 64;
    signal(SIGTERM, SIG_IGN);
    if (report_pid(argv[2]) != 0) return 2;
    /* Last-resort expiry; each family member has its own bound. */
    alarm(45);
    for (;;) pause();
}
