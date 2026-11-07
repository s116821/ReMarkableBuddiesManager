# Isolated owner extension. The qualification packet pins this exact file.
# Reuses the original nonce stage, lock, guard, claim and typed job machinery.
public_uptime_ms() {
    line=$(cat /proc/uptime) || return 1
    printf '%s\n' "$line" | awk 'NR!=1 || NF!=2 || $0 !~ /^(0|[1-9][0-9]*)\.[0-9][0-9] (0|[1-9][0-9]*)\.[0-9][0-9]$/ {exit 1}' || return 1
    seconds=${line%%.*}
    fraction=${line#*.}
    fraction=${fraction%% *}
    test "${#seconds}" -le 12 || return 1
    printf '%s\n' "$((seconds*1000+(1$fraction-100)*10))"
}

public_binding_valid() {
    printf '%s' "$1" | awk -v nonce="$nonce" -v boot="$expected_boot" -v connection="$public_connection" '
        BEGIN {FS=" "}
        {n=split($3, u, "-"); valid=n==5 && length(u[1])==8 && length(u[2])==4 &&
            length(u[3])==4 && length(u[4])==4 && length(u[5])==12;
            for (i=1;i<=n;i++) if (u[i] !~ /^[0-9a-f]+$/) valid=0}
        NR==1 && NF==7 && $0==$1" "$2" "$3" "$4" "$5" "$6" "$7 &&
        $1=="PublicStop1" && $2==nonce && $6==boot && $5==connection &&
        valid &&
        $3!="00000000-0000-0000-0000-000000000000" &&
        length($4)==64 && $4 ~ /^[0-9a-f]+$/ &&
        length($5)==64 && $5 ~ /^[0-9a-f]+$/ &&
        $7 ~ /^[1-9][0-9]*$/ && length($7)<=16 && $7<=9007199254740991 {ok=1}
        END {exit !(NR==1 && ok)}
    '
}

public_private_file() {
    job_file "$1" "$2" &&
        test "$(stat -c '%u:%g:%a:%h' -- "$1")" = 0:0:600:1
}

public_read_line() {
    public_record=$(cat "$1" && printf .) || return 1
    public_bytes=$(stat -c %s -- "$1") || return 1
    test "$public_bytes" -eq "$((${#public_record}-1))" || return 1
    newline='
'
    case "$public_record" in *"$newline".) ;; *) return 1 ;; esac
    public_line=${public_record%"$newline."}
}

read_public_binding() {
    public_private_file "$stage/public-stop-binding" 384 || return 1
    public_private_file "$stage/expected-connection" 65 || return 1
    public_read_line "$stage/expected-connection" || return 1
    public_connection=$public_line
    public_read_line "$stage/public-stop-binding" || return 1
    public_binding_valid "$public_line" || return 1
    public_cutoff=${public_line##* }
}

verify_public_send() {
    read_public_binding || return 1
    now_ms=$(public_uptime_ms) || return 1
    test "$now_ms" -lt "$public_cutoff"
}

publish_public_binding() {
    public_private_file "$stage/expected-connection" 65 || return 1
    public_read_line "$stage/expected-connection" || return 1
    public_connection=$public_line
    absent "$stage/public-stop-binding" && absent "$stage/public-stop-claim" &&
        absent "$stage/public-stop-job" || return 1
    candidate="$stage/public-stop-binding.$$"
    (set -C; dd bs=1 count=385 > "$candidate" 2>/dev/null) || return 1
    public_private_file "$candidate" 384 && public_read_line "$candidate" &&
        public_binding_valid "$public_line" || return 1
    flush_path "$candidate" && move_entry public-stop-binding "$candidate" "$stage/public-stop-binding"
}

public_stop() {
    test -f "$stage/trial-ready" && absent "$stage/closed" || return 1
    verify_timer_and_reserve && verify_common && verify_published_trial || return 1
    test "$guard_state" = open && test "$(observe)" = trial || return 1
    publish_public_binding && verify_public_send || return 1
    request_once public-stop
    manager_matches "$stage/public-stop-job/ack" && verify_public_send || return 1
    public_private_file "$stage/public-stop-job-accepted" 64 &&
        test "$(cat "$stage/public-stop-job-accepted")" = public-stop-job-accepted || return 1
    public_private_file "$stage/public-stop-job/reply" 8192 &&
        public_private_file "$stage/public-stop-job/identity" 512 || return 1
    ack_job=$(job_parse accept "$stage/public-stop-job/reply") || return 1
    ack_sha=$(hash_file "$stage/public-stop-job/reply") || return 1
    ack_identity=$(job_identity public-stop "$ack_job" "$ack_sha") || return 1
    test "$(cat "$stage/public-stop-job/identity")" = "$ack_identity" && verify_public_send || return 1
    printf '%s\n' "$ack_identity"
}
