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
    char filename[80], line[4096];
    snprintf(filename, sizeof(filename), "/proc/%ld/stat", parsed);
    struct stat info;
    if (stat(filename, &info) != 0 || info.st_uid != getuid()) { close(fd); return 5; }
    FILE *input = fopen(filename, "r");
    if (!input) { close(fd); return 5; }
    char *read = fgets(line, sizeof(line), input);
    fclose(input);
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
    } else if (strcmp(argv[1], "reader") == 0) {
        /* Same inode as ownership marker, deliberately offset zero. */
        if (open(argv[3], O_RDONLY) < 0) return 2;
    } else if (strcmp(argv[1], "sentinel") != 0) return 64;
    signal(SIGTERM, SIG_IGN);
    int report = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (report < 0) return 2;
    dprintf(report, "%ld\n", (long)getpid());
    close(report);
    /* Last-resort expiry if the harness itself crashes; no descendants. */
    alarm(45);
    for (;;) pause();
}
