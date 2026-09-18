#define _GNU_SOURCE
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <sys/syscall.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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
    char state;
} owned_process;

typedef enum {
    QUERY_ERROR = -1,
    QUERY_NO_MATCH = 0,
    QUERY_MATCH = 1,
} query_result;

typedef struct {
    bool ok;
    size_t count;
    pid_t query_error_pid;
} census_result;

static int64_t cleanup_deadline = -1;
static unsigned long census_call_count = 0;
static unsigned long identity_call_count = 0;
static unsigned long listpids_query_call_count = 0;
static unsigned long listpids_fill_call_count = 0;

typedef int (*listpids_api)(
    uint32_t type,
    uint32_t typeinfo,
    void *buffer,
    int buffersize,
    void *context
);

typedef struct {
    bool ok;
    pid_t *pids;
    size_t count;
} pid_list_result;

static int64_t monotonic_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) {
        return -1;
    }
    return ((int64_t)ts.tv_sec * 1000) + (ts.tv_nsec / 1000000);
}

static bool deadline_exceeded(void) {
    if (cleanup_deadline < 0) return false;
    int64_t now = monotonic_ms();
    if (now >= 0 && now < cleanup_deadline) return false;
    errno = ETIMEDOUT;
    return true;
}

static bool inject_identity_failure(pid_t pid) {
    const char *mode = getenv("ZYLOS_GUARDIAN_TEST_FAIL_IDENTITY");
    if (mode == NULL || *mode == '\0') {
        return false;
    }
    const char *failure_mode = mode;
    const char *separator = strchr(mode, ':');
    if (separator != NULL) {
        char target_text[32];
        size_t target_length = (size_t)(separator - mode);
        if (target_length == 0 || target_length >= sizeof(target_text)) {
            return false;
        }
        memcpy(target_text, mode, target_length);
        target_text[target_length] = '\0';
        char *end = NULL;
        errno = 0;
        long target = strtol(target_text, &end, 10);
        if (errno != 0 || end == target_text || *end != '\0' || target != pid) {
            return false;
        }
        failure_mode = separator + 1;
    }
    identity_call_count++;
    if (strcmp(failure_mode, "always") == 0) {
        return true;
    }
    unsigned long first = 0;
    unsigned long last = 0;
    return sscanf(failure_mode, "%lu-%lu", &first, &last) == 2 &&
           identity_call_count >= first && identity_call_count <= last;
}

/* Identity fields are opaque: start_sec is Linux boot-relative starttime ticks;
   start_usec is zero. Never interpret these fields as wall-clock timestamps. */
static query_result process_identity(pid_t pid, owned_process *out) {
    if (inject_identity_failure(pid)) { errno = EIO; return QUERY_ERROR; }
    char path[64], buffer[8192];
    snprintf(path, sizeof(path), "/proc/%d/stat", pid);
    FILE *file = fopen(path, "r");
    if (!file) return errno == ENOENT || errno == ESRCH ? QUERY_NO_MATCH : QUERY_ERROR;
    size_t n = fread(buffer, 1, sizeof(buffer)-1, file);
    bool bad = ferror(file) || !feof(file);
    fclose(file);
    if (bad || n == 0) { errno = EIO; return QUERY_ERROR; }
    buffer[n] = 0;
    char *open = strchr(buffer, '('), *close = strrchr(buffer, ')');
    if (!open || !close || close <= open || close[1] != ' ') { errno=EIO; return QUERY_ERROR; }
    owned_process value = {.pid=pid};
    size_t name_length = (size_t)(close-open-1);
    if (name_length >= sizeof(value.name)) name_length=sizeof(value.name)-1;
    memcpy(value.name, open+1, name_length);
    /* A process name is untrusted JSON input. Keep only printable safe ASCII. */
    for (size_t i=0;i<name_length;i++)
        if ((unsigned char)value.name[i]<32 || (unsigned char)value.name[i]>126 || value.name[i]=='"' || value.name[i]=='\\') value.name[i]='_';
    char *save=NULL, *token=strtok_r(close+2," \n",&save);
    char state=0;
    for (int field=3;field<=22;field++) {
        if (!token) { errno=EIO; return QUERY_ERROR; }
        if (field==3) {
            if (token[1] != '\0' || strchr("RSDZTtXxKWPI", token[0]) == NULL) { errno=EIO; return QUERY_ERROR; }
            state=token[0];
        }
        if (field==4 || field==5 || field==6 || field==22) {
            char *end=NULL; errno=0;
            unsigned long long number=strtoull(token,&end,10);
            if (errno || end==token || *end || token[0]=='-' || (field!=22 && number>INT32_MAX)) { errno=EIO; return QUERY_ERROR; }
            if (field==4) value.parent_pid=(pid_t)number;
            if (field==5) value.process_group_id=(pid_t)number;
            if (field==6) value.session_id=(pid_t)number;
            if (field==22) value.start_sec=number;
        }
        token=strtok_r(NULL," \n",&save);
    }
    /* Report zombies in identity output; same_identity/census treat them as
       resource-dead, not as an absent /proc entry. */
    value.state=state;
    snprintf(path,sizeof(path),"/proc/%d",pid);
    struct stat st;
    if (stat(path,&st)!=0) return errno==ENOENT || errno==ESRCH ? QUERY_NO_MATCH : QUERY_ERROR;
    value.uid=st.st_uid;
    if (out) *out=value;
    return QUERY_MATCH;
}

static query_result classify_failed_process_query(pid_t pid, int query_errno) {
    query_result identity_result = process_identity(pid, NULL);
    if (identity_result == QUERY_NO_MATCH) {
        return QUERY_NO_MATCH;
    }
    if (identity_result == QUERY_MATCH) {
        errno = query_errno != 0 ? query_errno : EIO;
    }
    return QUERY_ERROR;
}

static query_result same_identity(const owned_process *expected) {
    owned_process actual;
    query_result identity_result = process_identity(expected->pid, &actual);
    if (identity_result != QUERY_MATCH) {
        return identity_result;
    }
    if (actual.state=='Z' || actual.state=='X' || actual.state=='x') return QUERY_NO_MATCH;
    return actual.start_sec == expected->start_sec &&
           actual.start_usec == expected->start_usec ? QUERY_MATCH : QUERY_NO_MATCH;
}

static off_t marker_offset(const struct stat *marker_stat) {
    return MARKER_OFFSET_BIAS + (off_t)(marker_stat->st_ino & 0xfffff);
}

static query_result process_has_env(pid_t pid, const char *needle) {
    char path[64]; snprintf(path,sizeof(path),"/proc/%d/environ",pid);
    FILE *f=fopen(path,"r");
    if (!f) return classify_failed_process_query(pid,errno);
    char *entry=NULL; size_t capacity=0; ssize_t length; bool found=false;
    while ((length=getdelim(&entry,&capacity,0,f))>=0) {
        if ((size_t)length==strlen(needle)+1 && memcmp(entry,needle,(size_t)length-1)==0) found=true;
        if (capacity>16*1024*1024) { free(entry); fclose(f); errno=EOVERFLOW; return QUERY_ERROR; }
    }
    bool failed=ferror(f); int saved=errno; free(entry); fclose(f);
    if (failed) return classify_failed_process_query(pid,saved);
    return found ? QUERY_MATCH : QUERY_NO_MATCH;
}

static query_result process_has_marker_fd_once(pid_t pid, const char *path) {
    struct stat marker;
    if (stat(path,&marker)!=0 || !S_ISREG(marker.st_mode)) { errno=EINVAL; return QUERY_ERROR; }
    char directory[64]; snprintf(directory,sizeof(directory),"/proc/%d/fd",pid);
    DIR *dir=opendir(directory);
    if (!dir) return classify_failed_process_query(pid,errno);
    query_result result=QUERY_NO_MATCH;
    struct dirent *entry;
    for (;;) {
        if (deadline_exceeded()) { result=QUERY_ERROR; break; }
        errno=0; entry=readdir(dir);
        if (!entry) { if (errno) result=QUERY_ERROR; break; }
        if (entry->d_name[0]=='.') continue;
        char *end=NULL; long fd=strtol(entry->d_name,&end,10);
        if (!end || *end || fd<0 || fd>INT32_MAX) { errno=EIO; result=QUERY_ERROR; break; }
        char candidate[96]; snprintf(candidate,sizeof(candidate),"/proc/%d/fd/%ld",pid,fd);
        struct stat before,after;
        if (stat(candidate,&before)!=0) { result=QUERY_ERROR; break; }
        if (before.st_dev!=marker.st_dev || before.st_ino!=marker.st_ino) continue;
        char info[96]; snprintf(info,sizeof(info),"/proc/%d/fdinfo/%ld",pid,fd);
        FILE *f=fopen(info,"r");
        if (!f) { result=QUERY_ERROR; break; }
        char line[512]; unsigned long long position=0; bool have_position=false;
        while (fgets(line,sizeof(line),f)) {
            if (sscanf(line,"pos:\t%llu",&position)==1) have_position=true;
        }
        bool failed=ferror(f); fclose(f);
        if (failed || !have_position || stat(candidate,&after)!=0 || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino) { errno=EIO; result=QUERY_ERROR; break; }
        if (position==(unsigned long long)marker_offset(&marker)) { result=QUERY_MATCH; break; }
    }
    int saved=errno; closedir(dir);
    if (result==QUERY_ERROR) return classify_failed_process_query(pid,saved);
    return result;
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

static bool listpids_failure_selected(bool fill) {
    const char *mode = getenv("ZYLOS_GUARDIAN_TEST_FAIL_LISTPIDS");
    if (mode == NULL || *mode == '\0') {
        return false;
    }
    const char *separator = strchr(mode, ':');
    if (separator == NULL) {
        return false;
    }
    size_t phase_length = (size_t)(separator - mode);
    bool selected_phase = (fill && phase_length == 4 && memcmp(mode, "fill", 4) == 0) ||
                          (!fill && phase_length == 5 && memcmp(mode, "query", 5) == 0);
    if (!selected_phase) {
        return false;
    }
    unsigned long *call_count = fill ? &listpids_fill_call_count : &listpids_query_call_count;
    (*call_count)++;
    const char *failure_mode = separator + 1;
    if (strcmp(failure_mode, "always") == 0) {
        return true;
    }
    unsigned long first = 0;
    unsigned long last = 0;
    return sscanf(failure_mode, "%lu-%lu", &first, &last) == 2 &&
           *call_count >= first && *call_count <= last;
}

#define PROC_UID_ONLY 1
static int native_listpids(uint32_t type, uint32_t uid, void *buffer, int bytes, void *context) {
    (void)type; (void)context;
    bool fill=buffer!=NULL && bytes>0;
    if (listpids_failure_selected(fill)) { errno=EIO; return 0; }
    DIR *dir=opendir("/proc"); if (!dir) return 0;
    int count=0; struct dirent *entry; int failure=0;
    for (;;) {
        if (deadline_exceeded()) { failure=ETIMEDOUT; break; }
        errno=0; entry=readdir(dir);
        if (!entry) { failure=errno; break; }
        char *end=NULL; long id=strtol(entry->d_name,&end,10);
        if (end==entry->d_name || *end || id<=0 || id>INT32_MAX) continue;
        char path[64]; snprintf(path,sizeof(path),"/proc/%ld",id);
        struct stat st;
        if (stat(path,&st)!=0) { if (errno==ENOENT || errno==ESRCH) continue; failure=errno; break; }
        if (st.st_uid!=(uid_t)uid) continue;
        if (count>=MAX_PIDS) { failure=EOVERFLOW; break; }
        if (fill && count>=bytes/(int)sizeof(pid_t)) break;
        if (fill) ((pid_t*)buffer)[count]=(pid_t)id;
        count++;
    }
    closedir(dir);
    if (failure || count==0) { errno=failure ? failure : EIO; return 0; }
    return count*(int)sizeof(pid_t);
}

static pid_list_result list_owned_uid_pids(uint32_t owner_uid, listpids_api api, void *context) {
    pid_list_result result = {.ok = false, .pids = NULL, .count = 0};
    errno = 0;
    int estimated_bytes = api(PROC_UID_ONLY, owner_uid, NULL, 0, context);
    if (estimated_bytes <= 0 || estimated_bytes % (int)sizeof(pid_t) != 0) {
        if (errno == 0) {
            errno = EIO;
        }
        return result;
    }
    size_t estimated_count = (size_t)estimated_bytes / sizeof(pid_t);
    if (estimated_count > MAX_PIDS) {
        errno = EOVERFLOW;
        return result;
    }
    size_t pid_capacity = estimated_count > MAX_PIDS - INITIAL_PID_SLACK
        ? MAX_PIDS
        : estimated_count + INITIAL_PID_SLACK;

    for (;;) {
        if (pid_capacity == 0 || pid_capacity > MAX_PIDS ||
            pid_capacity > (size_t)INT32_MAX / sizeof(pid_t)) {
            errno = EOVERFLOW;
            return result;
        }
        pid_t *pids = calloc(pid_capacity, sizeof(pid_t));
        if (pids == NULL) {
            return result;
        }
        int buffer_bytes = (int)(pid_capacity * sizeof(pid_t));
        errno = 0;
        int returned_bytes = api(PROC_UID_ONLY, owner_uid, pids, buffer_bytes, context);
        if (returned_bytes <= 0 || returned_bytes > buffer_bytes ||
            returned_bytes % (int)sizeof(pid_t) != 0) {
            int query_errno = errno;
            free(pids);
            errno = query_errno != 0 ? query_errno : EIO;
            return result;
        }
        if (returned_bytes < buffer_bytes) {
            result.ok = true;
            result.pids = pids;
            result.count = (size_t)returned_bytes / sizeof(pid_t);
            return result;
        }
        free(pids);
        if (pid_capacity > MAX_PIDS / 2) {
            errno = EOVERFLOW;
            return result;
        }
        pid_capacity *= 2;
    }
}

typedef enum {
    FAKE_LISTPIDS_NORMAL,
    FAKE_LISTPIDS_ZERO_ALWAYS,
    FAKE_LISTPIDS_ZERO_ONCE,
    FAKE_LISTPIDS_SATURATE_ONCE,
    FAKE_LISTPIDS_MAX_SATURATED,
    FAKE_LISTPIDS_MISALIGNED,
} fake_listpids_mode;

typedef struct {
    fake_listpids_mode mode;
    int fill_calls;
    int first_buffer_bytes;
    int second_buffer_bytes;
} fake_listpids_context;

static int fake_listpids(
    uint32_t type,
    uint32_t typeinfo,
    void *buffer,
    int buffersize,
    void *raw_context
) {
    (void)type;
    (void)typeinfo;
    fake_listpids_context *context = raw_context;
    if (buffer == NULL || buffersize == 0) {
        if (context->mode == FAKE_LISTPIDS_MAX_SATURATED) {
            return MAX_PIDS * (int)sizeof(pid_t);
        }
        if (context->mode == FAKE_LISTPIDS_MISALIGNED) {
            return (int)sizeof(pid_t) + 1;
        }
        return 2 * (int)sizeof(pid_t);
    }
    context->fill_calls++;
    if (context->fill_calls == 1) {
        context->first_buffer_bytes = buffersize;
    } else if (context->fill_calls == 2) {
        context->second_buffer_bytes = buffersize;
    }
    if (context->mode == FAKE_LISTPIDS_ZERO_ALWAYS ||
        (context->mode == FAKE_LISTPIDS_ZERO_ONCE && context->fill_calls == 1)) {
        errno = EIO;
        return 0;
    }
    if (context->mode == FAKE_LISTPIDS_SATURATE_ONCE && context->fill_calls == 1) {
        return buffersize;
    }
    if (context->mode == FAKE_LISTPIDS_MAX_SATURATED) {
        return buffersize;
    }
    pid_t *pids = buffer;
    pids[0] = 101;
    pids[1] = 202;
    return 2 * (int)sizeof(pid_t);
}

static int run_listpids_selftest(void) {
    fake_listpids_context normal = {.mode = FAKE_LISTPIDS_NORMAL};
    pid_list_result normal_result = list_owned_uid_pids(501, fake_listpids, &normal);
    bool normal_ok = normal_result.ok && normal_result.count == 2 &&
                     normal_result.pids[0] == 101 && normal_result.pids[1] == 202;
    free(normal_result.pids);

    fake_listpids_context permanent = {.mode = FAKE_LISTPIDS_ZERO_ALWAYS};
    errno = 0;
    pid_list_result permanent_result = list_owned_uid_pids(501, fake_listpids, &permanent);
    int permanent_errno = errno;
    free(permanent_result.pids);

    fake_listpids_context temporary = {.mode = FAKE_LISTPIDS_ZERO_ONCE};
    errno = 0;
    pid_list_result temporary_first = list_owned_uid_pids(501, fake_listpids, &temporary);
    int temporary_errno = errno;
    free(temporary_first.pids);
    pid_list_result temporary_second = list_owned_uid_pids(501, fake_listpids, &temporary);
    bool temporary_recovered = temporary_second.ok && temporary_second.count == 2;
    free(temporary_second.pids);

    fake_listpids_context saturated = {.mode = FAKE_LISTPIDS_SATURATE_ONCE};
    pid_list_result saturated_result = list_owned_uid_pids(501, fake_listpids, &saturated);
    bool saturated_ok = saturated_result.ok && saturated_result.count == 2 &&
                        saturated.fill_calls == 2 &&
                        saturated.second_buffer_bytes == saturated.first_buffer_bytes * 2;
    free(saturated_result.pids);

    fake_listpids_context boundary = {.mode = FAKE_LISTPIDS_MAX_SATURATED};
    errno = 0;
    pid_list_result boundary_result = list_owned_uid_pids(501, fake_listpids, &boundary);
    int boundary_errno = errno;
    free(boundary_result.pids);

    fake_listpids_context misaligned = {.mode = FAKE_LISTPIDS_MISALIGNED};
    errno = 0;
    pid_list_result misaligned_result = list_owned_uid_pids(501, fake_listpids, &misaligned);
    int misaligned_errno = errno;
    free(misaligned_result.pids);

    bool pass = normal_ok && !permanent_result.ok && permanent_errno == EIO &&
                !temporary_first.ok && temporary_errno == EIO && temporary_recovered &&
                saturated_ok && !boundary_result.ok && boundary_errno == EOVERFLOW &&
                !misaligned_result.ok && misaligned_errno == EIO;
    printf("{\"event\":\"listpids-selftest\",\"result\":\"%s\","
           "\"normalCount\":%zu,\"permanentZeroErrno\":%d,"
           "\"temporaryZeroErrno\":%d,\"temporaryRecovered\":%s,"
           "\"saturationFillCalls\":%d,\"saturationFirstBytes\":%d,"
           "\"saturationSecondBytes\":%d,\"boundaryErrno\":%d,"
           "\"misalignedErrno\":%d}\n",
           pass ? "pass" : "fail",
           normal_result.count,
           permanent_errno,
           temporary_errno,
           temporary_recovered ? "true" : "false",
           saturated.fill_calls,
           saturated.first_buffer_bytes,
           saturated.second_buffer_bytes,
           boundary_errno,
           misaligned_errno);
    return pass ? 0 : 5;
}

static census_result census(const char *marker, pid_t skip_pid, owned_process *owned, size_t capacity) {
    census_result result = {.ok = false, .count = 0, .query_error_pid = 0};
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
    uint32_t owner_uid = (uint32_t)geteuid();
    pid_list_result pid_list = list_owned_uid_pids(owner_uid, native_listpids, NULL);
    if (!pid_list.ok) {
        return result;
    }
    pid_t *pids = pid_list.pids;
    size_t count = pid_list.count;

    owned_process *all = calloc(count, sizeof(owned_process));
    bool *selected = calloc(count, sizeof(bool));
    if (all == NULL || selected == NULL) {
        free(all);
        free(selected);
        free(pids);
        return result;
    }

    size_t all_count = 0;
    for (size_t i = 0; i < count; i++) {
        if (deadline_exceeded()) {
            free(all); free(selected); free(pids); return result;
        }
        pid_t pid = pids[i];
        if (pid <= 1 || pid == skip_pid) {
            continue;
        }
        query_result identity_result = process_identity(pid, &all[all_count]);
        if (identity_result == QUERY_ERROR) {
            int identity_errno = errno;
            result.query_error_pid = pid;
            free(all);
            free(selected);
            free(pids);
            errno = identity_errno;
            return result;
        }
        if (identity_result == QUERY_NO_MATCH) {
            continue;
        }
        if (all[all_count].state=='Z' || all[all_count].state=='X' || all[all_count].state=='x') continue;
        if (all[all_count].uid != geteuid()) {
            continue;
        }
        query_result marker_result = process_has_marker(pid, marker);
        if (marker_result == QUERY_ERROR) {
            int query_errno = errno;
            result.query_error_pid = pid;
            free(all);
            free(selected);
            free(pids);
            errno = query_errno != 0 ? query_errno : EIO;
            return result;
        }
        query_result stable = same_identity(&all[all_count]);
        if (stable == QUERY_ERROR) {
            int saved=errno; result.query_error_pid=pid;
            free(all); free(selected); free(pids); errno=saved; return result;
        }
        if (stable == QUERY_NO_MATCH) continue;
        selected[all_count] = marker_result == QUERY_MATCH;
        all_count++;
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
                if (j % 256 == 0 && deadline_exceeded()) {
                    free(all); free(selected); return result;
                }
                if (selected[j] && all[i].parent_pid == all[j].pid && all[i].start_sec >= all[j].start_sec) {
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
    printf("{\"event\":\"%s\",\"pid\":%d,\"parentPid\":%d,\"processGroupId\":%d,\"sessionId\":%d,\"startSec\":%llu,\"startUsec\":%llu,\"name\":\"%s\",\"state\":\"%c\"}\n",
           event,
           process->pid,
           process->parent_pid,
           process->process_group_id,
           process->session_id,
           (unsigned long long)process->start_sec,
           (unsigned long long)process->start_usec,
           process->name, process->state);
}

static bool signal_snapshot(const owned_process *owned, size_t count, int signal_number) {
    bool query_ok = true;
    for (size_t i = 0; i < count; i++) {
        if (deadline_exceeded()) return false;
        int handle=(int)syscall(SYS_pidfd_open,owned[i].pid,0);
        if (handle<0) {
            if (errno==ESRCH) continue;
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n",owned[i].pid,errno);
            query_ok=false; continue;
        }
        /* Open first, then validate identity. The pinned handle cannot retarget a reused PID. */
        query_result match=same_identity(&owned[i]);
        if (match==QUERY_MATCH) {
            print_process(signal_number==SIGTERM ? "term" : "kill",&owned[i]);
            if (syscall(SYS_pidfd_send_signal,handle,signal_number,NULL,0)!=0 && errno!=ESRCH) {
                query_ok=false;
                printf("{\"event\":\"signal-error\",\"pid\":%d,\"errno\":%d}\n",owned[i].pid,errno);
            }
        } else if (match==QUERY_ERROR) {
            query_ok=false;
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n",owned[i].pid,errno);
        }
        close(handle);
    }
    fflush(stdout);
    return query_ok;
}

static int cleanup(const char *marker, int deadline_ms) {
    int64_t started = monotonic_ms();
    if (started < 0) return 5;
    cleanup_deadline = started + deadline_ms;
    int64_t term_deadline = -1;
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
    bool tracked_overflow = false;

    for (;;) {
        int64_t now = monotonic_ms();
        if (now < 0 || now - started >= deadline_ms) break;
        census_result current_result = census(marker, getpid(), current, MAX_PIDS);
        if (!current_result.ok) {
            stable_zero = 0;
            printf("{\"event\":\"census-error\",\"errno\":%d,\"queryPid\":%d}\n",
                   errno, current_result.query_error_pid);
            fflush(stdout);
        }
        size_t current_count = current_result.ok ? current_result.count : 0;
        bool discovered_new = false;
        for (size_t i = 0; i < current_count; i++) {
            bool already_tracked = false;
            for (size_t j = 0; j < tracked_count; j++) {
                if (j % 256 == 0 && deadline_exceeded()) {
                    free(tracked); free(current); free(alive); return 3;
                }
                if (current[i].pid == tracked[j].pid &&
                    current[i].start_sec == tracked[j].start_sec &&
                    current[i].start_usec == tracked[j].start_usec) {
                    already_tracked = true;
                    break;
                }
            }
            if (!already_tracked) {
                if (tracked_count >= MAX_PIDS) {
                    tracked_overflow = true;
                    errno = EOVERFLOW;
                    printf("{\"event\":\"tracking-overflow\"}\n");
                } else {
                    tracked[tracked_count++] = current[i];
                    discovered_new = true;
                }
            }
        }
        if (discovered_new) {
            sent_term = false;
            term_deadline = -1;
        }

        size_t alive_count = 0;
        bool identity_queries_ok = true;
        for (size_t i = 0; i < tracked_count; i++) {
            if (deadline_exceeded()) {
                free(tracked); free(current); free(alive); return 3;
            }
            query_result identity_result = same_identity(&tracked[i]);
            if (identity_result == QUERY_ERROR) {
                printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n",
                       tracked[i].pid, errno);
                identity_queries_ok = false;
            } else if (identity_result == QUERY_MATCH) {
                alive[alive_count++] = tracked[i];
            }
        }
        if (!current_result.ok || !identity_queries_ok || tracked_overflow) {
            stable_zero = 0;
            if (alive_count > 0) {
                if (!sent_term && identity_queries_ok) {
                    if (signal_snapshot(alive, alive_count, SIGTERM)) {
                        sent_term = true;
                        term_deadline = monotonic_ms() + TERM_GRACE_MS;
                    }
                } else if (!sent_term) {
                    (void)signal_snapshot(alive, alive_count, SIGTERM);
                } else if (monotonic_ms() >= term_deadline) {
                    (void)signal_snapshot(alive, alive_count, SIGKILL);
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
            if (signal_snapshot(alive, alive_count, SIGTERM)) {
                sent_term = true;
                term_deadline = monotonic_ms() + TERM_GRACE_MS;
            }
        } else if (monotonic_ms() >= term_deadline) {
            (void)signal_snapshot(alive, alive_count, SIGKILL);
        }
        usleep(POLL_MS * 1000);
    }

    for (size_t i = 0; i < tracked_count; i++) {
        query_result identity_result = same_identity(&tracked[i]);
        if (identity_result == QUERY_ERROR) {
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n",
                   tracked[i].pid, errno);
        } else if (identity_result == QUERY_MATCH) {
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
    if (value[0] < '0' || value[0] > '9' || errno != 0 || end == value || *end != '\0') {
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
            "       %s identity <pid>\n"
            "       %s listpids-selftest\n",
            program, program, program, program, program);
}

int main(int argc, char **argv) {
    if (argc == 2 && strcmp(argv[1], "listpids-selftest") == 0) {
        return run_listpids_selftest();
    }

    if (argc == 4 && strcmp(argv[1], "inspect") == 0) {
        pid_t pid = 0;
        if (!parse_pid(argv[2], &pid)) {
            return 64;
        }
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
        if (!parse_pid(argv[2], &pid)) {
            return 64;
        }
        query_result identity_result = process_identity(pid, &identity);
        if (identity_result == QUERY_ERROR) {
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n", pid, errno);
            return 5;
        }
        if (identity_result == QUERY_NO_MATCH) {
            return 2;
        }
        print_process("identity", &identity);
        return 0;
    }

    if (argc == 3 && strcmp(argv[1], "census") == 0) {
        owned_process owned[MAX_PIDS];
        census_result census_value = census(argv[2], getpid(), owned, MAX_PIDS);
        if (!census_value.ok) {
            printf("{\"event\":\"census-error\",\"errno\":%d,\"queryPid\":%d}\n",
                   errno, census_value.query_error_pid);
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
        query_result parent_result = same_identity(&parent);
        if (parent_result == QUERY_ERROR) {
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n", parent_pid, errno);
            return 5;
        }
        if (parent_result == QUERY_MATCH) {
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
        if (result > 0 && (descriptor.revents & (POLLHUP | POLLERR | POLLNVAL))) {
            printf("{\"event\":\"liveness-gone\",\"pid\":%d}\n", parent_pid);
            fflush(stdout);
            close(fd);
            return cleanup(marker, (int)deadline_ms);
        }
        query_result parent_result = same_identity(&parent);
        if (parent_result == QUERY_ERROR) {
            printf("{\"event\":\"identity-error\",\"pid\":%d,\"errno\":%d}\n", parent_pid, errno);
            fflush(stdout);
            continue;
        }
        if (parent_result == QUERY_NO_MATCH) {
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
