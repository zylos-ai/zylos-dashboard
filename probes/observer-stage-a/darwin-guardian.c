#include <errno.h>
#include <libproc.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_PIDS 65536
#define INITIAL_PID_SLACK 1024
#define FD_SLACK_ENTRIES 16
#define POLL_MS 100
#define TERM_GRACE_MS 1500
#define ZERO_STABLE_PASSES 3
#define MARKER_OFFSET_BIAS ((off_t)0x5a170000)

typedef struct {
    pid_t pid;
    pid_t parent_pid;
    pid_t process_group_id;
    pid_t session_id;
    uid_t uid;
    uint64_t start_sec;
    uint64_t start_usec;
    char name[32];
} owned_process;

typedef enum {
    QUERY_ERROR = -1,
    QUERY_NO_MATCH = 0,
    QUERY_MATCH = 1,
} query_result;

typedef struct {
    bool ok;
    size_t count;
} census_result;

static bool debug_env_probe = false;
static unsigned long census_call_count = 0;

static int64_t monotonic_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return -1;
    }
    return ((int64_t)ts.tv_sec * 1000) + (ts.tv_nsec / 1000000);
}

static bool process_identity(pid_t pid, owned_process *out) {
    struct proc_bsdinfo info;
    int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size != (int)sizeof(info)) {
        return false;
    }
    if (out != NULL) {
        out->pid = pid;
        out->parent_pid = info.pbi_ppid;
        out->process_group_id = (pid_t)info.pbi_pgid;
        out->session_id = getsid(pid);
        out->uid = info.pbi_uid;
        out->start_sec = info.pbi_start_tvsec;
        out->start_usec = info.pbi_start_tvusec;
        snprintf(out->name, sizeof(out->name), "%s", info.pbi_name);
    }
    return true;
}

static bool same_identity(const owned_process *expected) {
    owned_process actual;
    return process_identity(expected->pid, &actual) &&
           actual.start_sec == expected->start_sec &&
           actual.start_usec == expected->start_usec;
}

static off_t marker_offset(const struct stat *marker_stat) {
    return MARKER_OFFSET_BIAS + (off_t)(marker_stat->st_ino & 0xfffff);
}

static query_result process_has_env(pid_t pid, const char *needle) {
    int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
    int argmax = 0;
    size_t argmax_size = sizeof(argmax);
    if (sysctlbyname("kern.argmax", &argmax, &argmax_size, NULL, 0) != 0 || argmax <= (int)sizeof(int)) {
        if (debug_env_probe) {
            fprintf(stderr, "kern.argmax failed errno=%d value=%d\n", errno, argmax);
        }
        return QUERY_ERROR;
    }

    size_t size = (size_t)argmax;
    char *buffer = calloc(1, size);
    if (buffer == NULL) {
        return QUERY_ERROR;
    }
    if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0 || size <= sizeof(int)) {
        if (debug_env_probe) {
            fprintf(stderr, "KERN_PROCARGS2 failed pid=%d errno=%d size=%zu\n", pid, errno, size);
        }
        free(buffer);
        return process_identity(pid, NULL) ? QUERY_ERROR : QUERY_NO_MATCH;
    }
    if (debug_env_probe) {
        fprintf(stderr, "KERN_PROCARGS2 pid=%d size=%zu argmax=%d\n", pid, size, argmax);
    }

    char *cursor = buffer + sizeof(int);
    char *end = buffer + size;
    bool found = false;
    size_t needle_len = strlen(needle);
    if (needle_len > 0 && needle_len <= size) {
        for (size_t i = sizeof(int); i + needle_len <= size; i++) {
            if (memcmp(buffer + i, needle, needle_len) == 0 &&
                (i == sizeof(int) || buffer[i - 1] == '\0') &&
                (i + needle_len == size || buffer[i + needle_len] == '\0')) {
                found = true;
                break;
            }
        }
    }
    if (found) {
        free(buffer);
        return QUERY_MATCH;
    }
    while (cursor < end) {
        while (cursor < end && *cursor == '\0') {
            cursor++;
        }
        if (cursor >= end) {
            break;
        }
        size_t remaining = (size_t)(end - cursor);
        size_t value_len = strnlen(cursor, remaining);
        if (value_len == remaining) {
            break;
        }
        if (value_len == needle_len && memcmp(cursor, needle, needle_len) == 0) {
            found = true;
            break;
        }
        cursor += value_len + 1;
    }

    free(buffer);
    return found ? QUERY_MATCH : QUERY_NO_MATCH;
}

static query_result process_has_marker_fd_once(pid_t pid, const char *path) {
    struct stat marker_stat;
    if (stat(path, &marker_stat) != 0 || !S_ISREG(marker_stat.st_mode)) {
        return QUERY_ERROR;
    }

    int required_size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, NULL, 0);
    if (required_size <= 0) {
        return process_identity(pid, NULL) ? QUERY_ERROR : QUERY_NO_MATCH;
    }
    struct proc_fdinfo *fds = NULL;
    int actual_size = 0;
    int capacity = required_size + FD_SLACK_ENTRIES * (int)sizeof(struct proc_fdinfo);
    for (int attempt = 0; attempt < 4; attempt++) {
        fds = calloc(1, (size_t)capacity);
        if (fds == NULL) {
            return QUERY_ERROR;
        }
        actual_size = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, fds, capacity);
        if (actual_size <= 0) {
            free(fds);
            return process_identity(pid, NULL) ? QUERY_ERROR : QUERY_NO_MATCH;
        }
        if (actual_size < capacity) {
            break;
        }
        free(fds);
        fds = NULL;
        if (capacity > INT32_MAX / 2) {
            return QUERY_ERROR;
        }
        capacity *= 2;
    }
    if (fds == NULL || actual_size >= capacity) {
        free(fds);
        return QUERY_ERROR;
    }

    bool found = false;
    int count = actual_size / (int)sizeof(struct proc_fdinfo);
    for (int i = 0; i < count; i++) {
        if (fds[i].proc_fdtype != PROX_FDTYPE_VNODE) {
            continue;
        }
        struct vnode_fdinfowithpath vnode;
        int vnode_size = proc_pidfdinfo(
            pid,
            fds[i].proc_fd,
            PROC_PIDFDVNODEPATHINFO,
            &vnode,
            sizeof(vnode)
        );
        if (vnode_size != (int)sizeof(vnode)) {
            free(fds);
            return process_identity(pid, NULL) ? QUERY_ERROR : QUERY_NO_MATCH;
        }
        const struct vinfo_stat *candidate = &vnode.pvip.vip_vi.vi_stat;
        if ((dev_t)candidate->vst_dev == marker_stat.st_dev &&
            (ino_t)candidate->vst_ino == marker_stat.st_ino &&
            vnode.pfi.fi_offset == marker_offset(&marker_stat)) {
            found = true;
            break;
        }
    }
    free(fds);
    return found ? QUERY_MATCH : QUERY_NO_MATCH;
}

static query_result process_has_marker_fd(pid_t pid, const char *path) {
    for (int attempt = 0; attempt < 4; attempt++) {
        query_result result = process_has_marker_fd_once(pid, path);
        if (result != QUERY_ERROR) {
            return result;
        }
        struct timespec pause = {.tv_sec = 0, .tv_nsec = 1000000};
        nanosleep(&pause, NULL);
    }
    return QUERY_ERROR;
}

static query_result process_has_marker(pid_t pid, const char *marker) {
    static const char prefix[] = "fdpath:";
    if (strncmp(marker, prefix, sizeof(prefix) - 1) == 0) {
        return process_has_marker_fd(pid, marker + sizeof(prefix) - 1);
    }
    return process_has_env(pid, marker);
}

static bool inject_census_failure(void) {
    census_call_count++;
    const char *mode = getenv("ZYLOS_GUARDIAN_TEST_FAIL_CENSUS");
    if (mode == NULL || *mode == '\0') {
        return false;
    }
    if (strcmp(mode, "always") == 0) {
        return true;
    }
    unsigned long first = 0;
    unsigned long last = 0;
    return sscanf(mode, "%lu-%lu", &first, &last) == 2 &&
           census_call_count >= first && census_call_count <= last;
}

static census_result census(const char *marker, pid_t skip_pid, owned_process *owned, size_t capacity) {
    census_result result = {.ok = false, .count = 0};
    if (inject_census_failure()) {
        errno = EIO;
        return result;
    }
    static const char fd_prefix[] = "fdpath:";
    bool fd_marker = strncmp(marker, fd_prefix, sizeof(fd_prefix) - 1) == 0;
    struct stat marker_stat;
    if (fd_marker && stat(marker + sizeof(fd_prefix) - 1, &marker_stat) != 0) {
        return result;
    }
    int estimated_count = proc_listallpids(NULL, 0);
    if (estimated_count <= 0) {
        return result;
    }
    size_t pid_capacity = (size_t)estimated_count + INITIAL_PID_SLACK;
    if (pid_capacity > MAX_PIDS) {
        return result;
    }
    pid_t *pids = NULL;
    int count = 0;
    for (;;) {
        pids = calloc(pid_capacity, sizeof(pid_t));
        if (pids == NULL) {
            return result;
        }
        count = proc_listallpids(pids, (int)(pid_capacity * sizeof(pid_t)));
        if (count < 0) {
            free(pids);
            return result;
        }
        if ((size_t)count < pid_capacity) {
            break;
        }
        free(pids);
        pids = NULL;
        if (pid_capacity > MAX_PIDS / 2) {
            return result;
        }
        pid_capacity *= 2;
    }

    owned_process *all = calloc((size_t)count, sizeof(owned_process));
    bool *selected = calloc((size_t)count, sizeof(bool));
    if (all == NULL || selected == NULL) {
        free(all);
        free(selected);
        free(pids);
        return result;
    }

    size_t all_count = 0;
    for (int i = 0; i < count; i++) {
        pid_t pid = pids[i];
        if (pid <= 1 || pid == skip_pid) {
            continue;
        }
        if (process_identity(pid, &all[all_count])) {
            if (all[all_count].uid != geteuid()) {
                continue;
            }
            if (fd_marker &&
                (all[all_count].start_sec < (uint64_t)marker_stat.st_birthtimespec.tv_sec ||
                 (all[all_count].start_sec == (uint64_t)marker_stat.st_birthtimespec.tv_sec &&
                  all[all_count].start_usec < (uint64_t)(marker_stat.st_birthtimespec.tv_nsec / 1000)))) {
                continue;
            }
            query_result marker_result = process_has_marker(pid, marker);
            if (marker_result == QUERY_ERROR) {
                free(all);
                free(selected);
                free(pids);
                return result;
            }
            selected[all_count] = marker_result == QUERY_MATCH;
            all_count++;
        }
    }
    free(pids);

    bool changed;
    do {
        changed = false;
        for (size_t i = 0; i < all_count; i++) {
            if (selected[i]) {
                continue;
            }
            for (size_t j = 0; j < all_count; j++) {
                if (selected[j] && all[i].parent_pid == all[j].pid) {
                    selected[i] = true;
                    changed = true;
                    break;
                }
            }
        }
    } while (changed);

    size_t owned_count = 0;
    for (size_t i = 0; i < all_count && owned_count < capacity; i++) {
        if (selected[i]) {
            owned[owned_count++] = all[i];
        }
    }
    free(all);
    free(selected);
    result.ok = true;
    result.count = owned_count;
    return result;
}

static void print_process(const char *event, const owned_process *process) {
    printf("{\"event\":\"%s\",\"pid\":%d,\"parentPid\":%d,\"processGroupId\":%d,\"sessionId\":%d,\"startSec\":%llu,\"startUsec\":%llu,\"name\":\"%s\"}\n",
           event,
           process->pid,
           process->parent_pid,
           process->process_group_id,
           process->session_id,
           (unsigned long long)process->start_sec,
           (unsigned long long)process->start_usec,
           process->name);
}

static void signal_snapshot(const owned_process *owned, size_t count, int signal_number) {
    for (size_t i = 0; i < count; i++) {
        if (!same_identity(&owned[i])) {
            continue;
        }
        print_process(signal_number == SIGTERM ? "term" : "kill", &owned[i]);
        if (kill(owned[i].pid, signal_number) != 0 && errno != ESRCH) {
            fprintf(stderr, "signal failed pid=%d errno=%d\n", owned[i].pid, errno);
        }
    }
    fflush(stdout);
}

static int cleanup(const char *marker, int deadline_ms) {
    int64_t started = monotonic_ms();
    int64_t term_deadline = started + TERM_GRACE_MS;
    int stable_zero = 0;
    bool sent_term = false;
    owned_process *tracked = calloc(MAX_PIDS, sizeof(owned_process));
    owned_process *current = calloc(MAX_PIDS, sizeof(owned_process));
    owned_process *alive = calloc(MAX_PIDS, sizeof(owned_process));
    if (tracked == NULL || current == NULL || alive == NULL) {
        free(tracked);
        free(current);
        free(alive);
        return 5;
    }
    size_t tracked_count = 0;

    while (monotonic_ms() - started < deadline_ms) {
        census_result current_result = census(marker, getpid(), current, MAX_PIDS);
        if (!current_result.ok) {
            stable_zero = 0;
            printf("{\"event\":\"census-error\",\"errno\":%d}\n", errno);
            fflush(stdout);
        }
        size_t current_count = current_result.ok ? current_result.count : 0;
        for (size_t i = 0; i < current_count; i++) {
            bool already_tracked = false;
            for (size_t j = 0; j < tracked_count; j++) {
                if (current[i].pid == tracked[j].pid &&
                    current[i].start_sec == tracked[j].start_sec &&
                    current[i].start_usec == tracked[j].start_usec) {
                    already_tracked = true;
                    break;
                }
            }
            if (!already_tracked && tracked_count < MAX_PIDS) {
                tracked[tracked_count++] = current[i];
            }
        }

        size_t alive_count = 0;
        for (size_t i = 0; i < tracked_count; i++) {
            if (same_identity(&tracked[i])) {
                alive[alive_count++] = tracked[i];
            }
        }
        if (!current_result.ok) {
            if (alive_count > 0) {
                if (!sent_term) {
                    signal_snapshot(alive, alive_count, SIGTERM);
                    sent_term = true;
                } else if (monotonic_ms() >= term_deadline) {
                    signal_snapshot(alive, alive_count, SIGKILL);
                }
            }
            usleep(POLL_MS * 1000);
            continue;
        }
        if (alive_count == 0) {
            stable_zero++;
            if (stable_zero >= ZERO_STABLE_PASSES) {
                printf("{\"event\":\"clean\",\"elapsedMs\":%lld}\n",
                       (long long)(monotonic_ms() - started));
                fflush(stdout);
                free(tracked);
                free(current);
                free(alive);
                return 0;
            }
            usleep(POLL_MS * 1000);
            continue;
        }

        stable_zero = 0;
        for (size_t i = 0; i < alive_count; i++) {
            print_process("owned", &alive[i]);
        }
        if (!sent_term) {
            signal_snapshot(alive, alive_count, SIGTERM);
            sent_term = true;
        } else if (monotonic_ms() >= term_deadline) {
            signal_snapshot(alive, alive_count, SIGKILL);
        }
        usleep(POLL_MS * 1000);
    }

    for (size_t i = 0; i < tracked_count; i++) {
        if (same_identity(&tracked[i])) {
            print_process("survivor", &tracked[i]);
        }
    }
    fflush(stdout);
    free(tracked);
    free(current);
    free(alive);
    return 3;
}

static bool parse_u64(const char *value, uint64_t *out) {
    char *end = NULL;
    errno = 0;
    unsigned long long parsed = strtoull(value, &end, 10);
    if (errno != 0 || end == value || *end != '\0') {
        return false;
    }
    *out = (uint64_t)parsed;
    return true;
}

static bool parse_pid(const char *value, pid_t *out) {
    uint64_t parsed = 0;
    if (!parse_u64(value, &parsed) || parsed == 0 || parsed > INT32_MAX) {
        return false;
    }
    *out = (pid_t)parsed;
    return true;
}

static void usage(const char *program) {
    fprintf(stderr,
            "usage: %s watch <fd> <parent-pid> <start-sec> <start-usec> <marker> <deadline-ms>\n"
            "       %s reconcile <parent-pid> <start-sec> <start-usec> <marker> <deadline-ms>\n"
            "       %s census <marker>\n"
            "       %s identity <pid>\n",
            program, program, program, program);
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "inspect") == 0) {
        pid_t pid = 0;
        if (!parse_pid(argv[2], &pid)) {
            return 64;
        }
        debug_env_probe = true;
        query_result found = process_has_env(pid, argv[3]);
        printf("{\"event\":\"inspect\",\"pid\":%d,\"found\":%s,\"queryOk\":%s}\n",
               pid,
               found == QUERY_MATCH ? "true" : "false",
               found == QUERY_ERROR ? "false" : "true");
        return found == QUERY_MATCH ? 0 : (found == QUERY_NO_MATCH ? 2 : 5);
    }

    if (argc == 3 && strcmp(argv[1], "identity") == 0) {
        pid_t pid = 0;
        owned_process identity;
        if (!parse_pid(argv[2], &pid) || !process_identity(pid, &identity)) {
            return 2;
        }
        print_process("identity", &identity);
        return 0;
    }

    if (argc == 3 && strcmp(argv[1], "census") == 0) {
        owned_process owned[MAX_PIDS];
        census_result census_value = census(argv[2], getpid(), owned, MAX_PIDS);
        if (!census_value.ok) {
            printf("{\"event\":\"census-error\",\"errno\":%d}\n", errno);
            return 5;
        }
        size_t count = census_value.count;
        for (size_t i = 0; i < count; i++) {
            print_process("owned", &owned[i]);
        }
        printf("{\"event\":\"count\",\"count\":%zu}\n", count);
        return count == 0 ? 0 : 2;
    }

    bool watch = argc == 8 && strcmp(argv[1], "watch") == 0;
    bool reconcile = argc == 7 && strcmp(argv[1], "reconcile") == 0;
    if (!watch && !reconcile) {
        usage(argv[0]);
        return 64;
    }

    int offset = watch ? 3 : 2;
    pid_t parent_pid = 0;
    uint64_t start_sec = 0;
    uint64_t start_usec = 0;
    uint64_t deadline_ms = 0;
    if (!parse_pid(argv[offset], &parent_pid) ||
        !parse_u64(argv[offset + 1], &start_sec) ||
        !parse_u64(argv[offset + 2], &start_usec) ||
        !parse_u64(argv[offset + 4], &deadline_ms) || deadline_ms > INT32_MAX) {
        usage(argv[0]);
        return 64;
    }

    owned_process parent = {
        .pid = parent_pid,
        .start_sec = start_sec,
        .start_usec = start_usec,
    };
    const char *marker = argv[offset + 3];

    if (reconcile) {
        if (same_identity(&parent)) {
            printf("{\"event\":\"parent-alive\",\"pid\":%d}\n", parent_pid);
            return 4;
        }
        printf("{\"event\":\"reconcile\",\"pid\":%d}\n", parent_pid);
        return cleanup(marker, (int)deadline_ms);
    }

    char *fd_end = NULL;
    errno = 0;
    long fd_value = strtol(argv[2], &fd_end, 10);
    if (errno != 0 || fd_end == argv[2] || *fd_end != '\0' || fd_value < 0 || fd_value > INT32_MAX) {
        usage(argv[0]);
        return 64;
    }
    int fd = (int)fd_value;
    printf("{\"event\":\"watching\",\"pid\":%d,\"parentPid\":%d}\n", getpid(), parent_pid);
    fflush(stdout);

    for (;;) {
        struct pollfd descriptor = {.fd = fd, .events = POLLIN | POLLHUP};
        int result = poll(&descriptor, 1, POLL_MS);
        if (result < 0 && errno != EINTR) {
            fprintf(stderr, "poll failed errno=%d\n", errno);
            return 5;
        }
        if (!same_identity(&parent) ||
            (result > 0 && (descriptor.revents & (POLLHUP | POLLERR | POLLNVAL)))) {
            printf("{\"event\":\"parent-gone\",\"pid\":%d}\n", parent_pid);
            fflush(stdout);
            close(fd);
            return cleanup(marker, (int)deadline_ms);
        }
        if (result > 0 && (descriptor.revents & POLLIN)) {
            char byte;
            ssize_t read_result = read(fd, &byte, 1);
            if (read_result == 0) {
                printf("{\"event\":\"liveness-eof\",\"pid\":%d}\n", parent_pid);
                fflush(stdout);
                close(fd);
                return cleanup(marker, (int)deadline_ms);
            }
            if (read_result < 0 && errno != EINTR) {
                fprintf(stderr, "read failed errno=%d\n", errno);
                return 5;
            }
        }
    }
}
