# Manage an ordinary historical conversation

Both companions expose the same optional conversation-management capability through
the existing identity-verified wired helper. This flow supports the shipped
ordinary schema-one producer. An unsupported generation, selected/sync mode,
unfinished conversation, busy service or unreadable Store refuses without an
alternate query or service-state change. Manager does not stop or restart Buddy.

1. Connect and read tablet state, then **Inspect conversation IDs**.
2. In **Conversation management**, explicitly choose an ID from that current
   snapshot. No row is selected automatically; an ID proves no removal eligibility.
3. **Inspect selected conversation**, then **Prepare logical removal preview**.
   Both are fresh producer reads. Review the new prepared counts; the earlier
   inspect counts are not write permission. Preview stages expire after two minutes
   and other maintenance operations invalidate idle previews.
4. Deliberately **Confirm logical removal** once. This removes only the current
   supported conversation root and optional historical binding logically. Retained
   history, turns, source images/media, export associations and native pages remain.
   No physical space or synchronized deletion is promised. Runtime remains unverified.
5. If the outcome is unknown or unresolved, use **Check original logical removal**.
   It sends the same original private intent read-only. Never retry confirmation or
   substitute a newly prepared operation. An unchanged observation also gives no
   retry permission and does not prove that no historical deletion occurred.

A verified receipt acknowledges that original operation. Current conversation
state is displayed separately and may have changed afterward. Matching tombstones
without the exact original receipt remain unresolved. A refusal is never treated
as an empty conversation or proof of absence.

**Stop conversation management wait** affects only the captured local invocation;
it cannot undo remote publication. Before a reference is known, Stop detaches only
this UI wait and bounded host work may remain Busy. Queued observation must settle
successfully before dispatch; Stop or wait expiry prevents later dispatch.

Original inputs stay private in the current host process, at most eight retained
operations and 32 invocation entries each. Original Status availability expires
30 minutes after possible Apply dispatch and is never renewed by checking.
**Show original operations on this computer** reads host memory only. Restart,
expiry or exhausted capacity cannot recover an original and never authorizes a
replacement operation. Keep the current process available for original Status.
No private intents, receipt IDs, Config paths, content or diagnostic text enter the
renderer or persistence. IDs shown here are Buddy conversation IDs, not native page IDs.

The central change `manage-historical-conversation-companion` owns the proposed
consumer contract and qualification record. Until paired source/package review is
complete, local synthetic checks do not establish device, native or runtime readiness.
Manual/fork workflows use ordinary repository commands; private tracking is optional.
