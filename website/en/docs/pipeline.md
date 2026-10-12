---
title: Background work and recovery
description: Understand input counts, queued work, commits, pauses, and missing results.
---

# Background work and recovery

Memory processing needs model calls and usually takes time. Distinguish counting inputs, queuing a request, running an agent, and committing successfully. Only a successful commit establishes that the batch was processed.

## When extraction starts

When L1 is idle, each interactive user input increases its counter. The default threshold is **10 inputs**. After reaching it, the extension waits for the current response and agent activity to finish, checks the archive, and schedules extraction. Tool calls and automatic follow-ups do not increase the counter.

The counter pauses while L1 is queued or running, but conversations are still archived. After a successful batch, remaining input schedules another batch without waiting for 10 more inputs. A batch reads up to 25 new user or assistant messages. Committing progress without saving new records is valid when nothing is worth keeping.

L2 is scheduled after L1 drains its backlog and new records exist. L3 considers scene changes, first generation, accumulated new records (a threshold of 30), and explicit requests. L1, L2, and L3 share a serial queue, with L3 ordered last. Skill review runs separately with its own count and progress.

```text
Count inputs → Queue request → Process → Commit successfully → Save progress
                                  │
                                  └→ Fail or finish without commit
                                       → Keep prior progress → Process on a later trigger
```

## Check current progress

Pi's status bar shows inputs remaining before L1's trigger, the current background layer, and skill-review status. The remaining input count is not a completion countdown.

The viewer's Pipeline page shows queued, running, and recently finished jobs, plus pending trigger signals. A viewer trigger first saves a signal. An active Pi main session must consume it when agent activity settles; opening only the viewer does not run extraction.

| What you see | Meaning | Next step |
| --- | --- | --- |
| Pending trigger signal | Pi has not consumed the request | Return to Pi and let current activity finish normally |
| Queued | Registered behind earlier work | Check the running layer |
| Running | Processing or waiting for a model | Check elapsed time and layer logs |
| Completed, no new records | Possibly no useful candidates or only duplicates | Inspect results, sources, and value-check logs |
| Paused after failures | Automatic execution for that layer stopped | Fix the cause, then trigger that layer manually |

## Request processing manually

Choose the appropriate command inside **Pi**:

```text
/my-memory:l1-trigger
/my-memory:l2-trigger
/my-memory:l3-trigger
```

Manual requests use the same queue. They do not bypass running work or guarantee an immediate profile proposal.

## Recover from failure

Without a successful commit, prior progress remains, allowing the next run to read unprocessed input. Some data may already have been written during a partial failure, so retaining progress does not imply every write was rolled back.

After **3 consecutive failures**, that layer pauses automatic execution while other unpaused layers can continue. Pause state is persisted; restarting alone does not fix the cause.

1. Find the failed layer and error on the Pipeline page.
2. Check background model availability, quota, and network. For vector errors, also inspect Embedding configuration.
3. Fix the cause and trigger that layer manually in Pi. A paused queued job is resumed when available.
4. Wait for a successful commit, then inspect records, scenes, or proposals and their progress.

Logs are in the active profile's `memoryDB/logs/`, grouped by scopes such as `l1`, `l2`, `l3`, `pipeline`, and `recall`. Check for private content and credentials before sharing.

## Long-running tasks and stopping

The built-in soft threshold is **10 minutes 30 seconds** (`630000` milliseconds). It logs slow work and keeps waiting. The hard limit is **30 minutes**. Actual values can be overridden in `subagent` configuration. A session file may stop growing during model generation without the agent being stuck.

For an early stop, use the Pipeline page or run this inside Pi:

```text
/my-memory:subagent-kill l1
```

Replace `l1` with the appropriate layer. The extension first blocks background writes, gives an in-progress commit time to finish, then stops and checks the process. Repairs follow confirmed exit. If exit cannot be confirmed, writes for that layer are temporarily isolated. Do not delete locks to force it to continue.

Closing the main session stops new dispatches. Running tasks finish under their original profile's rules. Saved follow-up work resumes once that profile has an active session again.

Continue with [Configuration guide](./configuration) or [Command reference](./commands).
