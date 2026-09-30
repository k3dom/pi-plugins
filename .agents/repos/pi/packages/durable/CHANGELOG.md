# Changelog

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.
- Split `Tx.createConversation()` from `Tx.forkConversation()`, replaced raw conversation-record input, and require explicit ownerless or task ownership.
- Replaced untyped numeric record IDs and the `TaskRef` wrapper with erased branded numeric ID types, including result-typed `TaskId<R>`, separately branded commit sequences, and generic `Storage.mintId()`.
- Made task conversation membership immutable after task creation.
- Added `ConversationQuery` to Storage and transaction conversation scans.
- Added required `StoredDocument.deltasSinceBase` to Storage document reads.
- Task definitions now require an exhaustive `phases` map and an `abort` handler; define them with `defineTask()`.
- `RegistryReader` now requires `subscribe()`.
- Removed `Tx.setTask()`; a task changes its own state by returning the next state from its `runtime.commit()` callback.
- `Session.subscribeClose()` listeners now run synchronously when close begins, after admission is sealed.
- `defineEntry<D>()` now takes the entry's `data` type instead of a record type; `Entry<D>.is()` narrows to `TypedEntry<D>`.
- Added the required `Storage.scanSubmissions()` scan of submissions by conversation and status.
- `createRegistry()` now pre-registers the built-in `pi.generation` task and `pi` conversation setup, which cannot be disposed or replaced, and `Harness.open()` rejects a registry whose snapshot lacks either.
- `RegistrySnapshot` now requires `conversationSetups()`.
- `Tx` now requires `settleSubmission()`.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.
- Added policy-driven backend-side conversation document copying when creating forks.
- Added indexed conversation ownership queries and guaranteed no-effect Storage rejection handling.
- Added the JSONL storage backend (`@earendil-works/pi-durable/storage/jsonl`, and `openNodeJsonlStorage()` from `@earendil-works/pi-durable/storage/jsonl/node`), including sidecar reclamation.
- Added the execution environment (`@earendil-works/pi-durable/env`, and `NodeExecutionEnv` from `@earendil-works/pi-durable/env/node`) for file access and shell execution with bounded output capture and truncation.
- Added the `@earendil-works/pi-durable/testing` export with the scoped storage conformance suite (`createStorageConformance()`, `registerStorageConformance()`) and storage benchmark workloads ([#9977](https://github.com/earendil-works/pi/pull/9977) by [@christianklotz](https://github.com/christianklotz)).
- Added incarnation-bound read-only Chord document states and serialized asynchronous document watches with bounded exact-frame buffering.
- Added `deltasSinceBase` checkpoint predicate information so definitions can bound replay without value counters.
- Added `Harness.open()` with lazy root creation, atomic conversation creation and forks with `init`, conversation-bound commits, fork-aware entry pagination, model context derivation, and the built-in `ConversationConfig` document with model, thinking level, and active tool accessors.
- Added `createRegistry()` for tools, tool wrappers, hooks, tasks, and system prompt sections with batched publication and stable keyed ordering.
- Added `defineEntry()` typed entry kinds.
- Added the durable task runtime: `defineTask()`, registry-resolved phase handlers with checkpoint progress rules decided on the Session line, migration at reservation, typed runtime commits, memos, `sleep()`, and invocation-owned watches, plus `Harness.resume()`, `getTask()`, `waitForTask()`, `abortTask()`, and task-aware `waitForIdle()` on the Harness and conversations. Open reconciles running tasks to pending; tasks without a fitting definition stay blocked until registration, and aborting them settles them as `orphaned`.
- Added the first runnable chat turn: `Conversation.submit()` with request-ID deduplication, `Submission` handles (`status()`, `wait()`, `abort()`), `Harness.submission()`, `Harness.abortSubmission()`, and `ConversationBusy` for submissions to a busy conversation.
- Added the built-in `pi.generation` task: positional system prompt preparation from registered sections (tags, wrappers, failures, minimal patches, order rewrites, and head-cut rebaselines), model requests through `Models`, durable throttled partials in the `pi.live` document (`LiveDoc`), retries with backoff, deferred-response polling and cancellation, and aborted-partial conversion.
- Added `Tx.settleSubmission()`, which run tasks use to settle the inputs they answer.
- Added built-in entry tokens `UserEntry`, `AssistantEntry`, `SystemEntry`, and `ToolResultEntry`, and token-first `tx.entry()` and `tx.appendEntry()` overloads.
- Added `streamOptions` and `retry` to `ConversationConfig` with `get/setStreamOptions()` and `get/setRetryPolicy()` on conversations.
- Added `snapshot()`, `snapshotAsOf()`, `context()`, `now()`, and `report()` to `TaskRuntime`.
- Added `Harness.inspect()`: live tasks with their derived scheduler state (running, ready, waiting, or blocked with its reason), queued and placed submissions, and registry wrapper failures.
- Entries appended by a task's runtime commits now record the task as `byTaskId`.
- Added `registry.conversations.setup()`: setups run in every Harness commit that creates or forks a conversation, including raw `Tx.createConversation()` and `Tx.forkConversation()`, before host `init`. The built-in `pi` setup runs first and stages the default configuration with every registered tool active (forks keep their copied configuration) and an empty `pi.live`.
- `Conversation.submit()`, `Submission.wait()`, `waitForTask()`, and `waitForIdle()` now enable task scheduling, so they never wait on a Harness whose `resume()` was not called.
- Scheduler-written `faulted` and `orphaned` outcomes of a run task now settle the run's input submissions `unanswered` and clear its run control in the same commit.

### Fixed

- Fixed cached documents skipping migration when accessed with a newer definition version, and older definitions reading values migrated only in memory. Document states and watches hydrated under another definition version receive the new value as a root replacement.

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.
