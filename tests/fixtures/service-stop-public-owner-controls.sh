set -eu
umask 077
. /owner/ordinary-trial.sh
. /owner/job-receipt.sh
. /owner/service-stop-public-owner.sh
here=/owner
nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
expected_boot=11111111-1111-4111-8111-111111111111
expected_bus=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
expected_manager=:1.4
trial_invocation=20:27:ffffffffffffffffffffffffffffffff:40:2:4
connection=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
sample=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
invocation=22222222-2222-4222-8222-222222222222
guard_state=open
absent() { test ! -e "$1" && test ! -L "$1"; }
checkpoint() {
    case "$mode:$1" in
        binding-publish:before-public-stop-binding|marker-publish:before-mark-public-stop-job-accepted)
            return 1 ;;
    esac
}
flush_path() {
    case "$mode:$1" in
        binding-temp:*/public-stop-binding.[0-9]*) return 1 ;;
        binding-parent:"$stage") test ! -f "$stage/public-stop-binding" || return 1 ;;
        flush:*/public-stop-job/reply|identity-flush:*/public-stop-job/identity|job-dir-flush:*/public-stop-job)
            return 1 ;;
        marker-parent:"$stage") test ! -f "$stage/public-stop-job-accepted" || return 1 ;;
    esac
}
verify_timer_and_reserve() { return 0; }
verify_common() { return 0; }
verify_published_trial() { return 0; }
observe() { printf 'trial\n'; }
verify_stop_owner() { return 0; }
verify_stop_budget() { return 0; }
public_uptime_ms() {
    if test "$mode" = cutoff-preparation && test -f "$stage/public-stop-job/before-queue"; then
        printf '1000\n'
    else
        printf '%s\n' "$clock"
    fi
}
manager_matches() { case "$mode:$1" in lost:*/ack) return 1;; esac; }
verify_stop_retired() { test "$mode" != populated; }
service_action() { record_job "$1"; }
job_call() {
    target_file=$1
    shift 5
    case "$1" in
        ListJobs)
            if test "$mode" = pending && test "${target_file##*/}" = queue; then
                printf '%s\n' '{"type":"a(usssoo)","data":[[[51,"reader-buddy.service","stop","running","/org/freedesktop/systemd1/job/51","/org/freedesktop/systemd1/unit/reader_2dbuddy_2eservice"]]]}' > "$target_file"
            else
                printf '%s\n' '{"type":"a(usssoo)","data":[[]]}' > "$target_file"
            fi ;;
        EnqueueUnitJob)
            test -f "$stage/public-stop-claim" && test -f "$stage/public-stop-binding" || return 1
            printf 'sent\n' >> "$stage/sends"
            if test "$mode" = malformed; then printf '{}\n' > "$target_file"; else
                printf '%s\n' '{"type":"uososa(uosos)","data":[51,"/org/freedesktop/systemd1/job/51","reader-buddy.service","/org/freedesktop/systemd1/unit/reader_2dbuddy_2eservice","stop",[]]}' > "$target_file"
            fi ;;
        *) return 1 ;;
    esac
}
for mode in good expired flush lost malformed invalid binding-temp binding-publish binding-parent \
    identity-flush job-dir-flush marker-publish marker-parent cutoff-preparation; do
    stage=$(mktemp -d)
    printf '%s\n' "$connection" > "$stage/expected-connection"
    : > "$stage/trial-ready"
    clock=900
    case "$mode" in expired) clock=1000;; esac
    if test "$mode" = invalid; then input='wrong'; else
        input="PublicStop1 $nonce $invocation $sample $connection $expected_boot 1000"
    fi
    if (set -e; printf '%s\n' "$input" | (set -e; public_stop) > "$stage/ack"); then
        test "$mode" = good
        test -s "$stage/public-stop-job-accepted"
        cmp "$stage/ack" "$stage/public-stop-job/identity"
    else
        test "$mode" != good
        test ! -s "$stage/ack"
    fi
    case "$mode" in
        good|lost)
            test -s "$stage/public-stop-job-accepted"
            test "$(wc -l < "$stage/sends")" -eq 1
            if (set -e; printf '%s\n' "$input" | public_stop); then exit 1; fi
            test "$(wc -l < "$stage/sends")" -eq 1
            saved_mode=$mode
            mode=pending
            if settle_job public-stop; then exit 1; fi
            mode=populated
            if settle_job public-stop; then exit 1; fi
            mode=$saved_mode
            settle_job public-stop ;;
        flush|malformed|identity-flush|job-dir-flush|marker-publish)
            test "$(wc -l < "$stage/sends")" -eq 1
            test ! -e "$stage/public-stop-job-accepted"
            if settle_job public-stop; then exit 1; fi ;;
        marker-parent)
            test "$(wc -l < "$stage/sends")" -eq 1
            test -f "$stage/public-stop-job-accepted" && test ! -s "$stage/ack"
            if (set -e; printf '%s\n' "$input" | public_stop); then exit 1; fi
            test "$(wc -l < "$stage/sends")" -eq 1 ;;
        expired|invalid|binding-temp|binding-publish|binding-parent|cutoff-preparation)
            test ! -e "$stage/sends"
            test ! -e "$stage/public-stop-job-accepted"
            if test "$mode" = cutoff-preparation; then
                test -f "$stage/public-stop-claim" && test -f "$stage/public-stop-job/before-queue"
            else
                test ! -e "$stage/public-stop-claim"
            fi ;;
    esac
    printf '%s passed\n' "$mode"
done
