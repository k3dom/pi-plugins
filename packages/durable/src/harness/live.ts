import type { Draft, JsonRepresentation, JsonValue } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { defineDoc } from "../documents.ts";
import type { Transaction } from "../session/transaction.ts";
import type { SubmissionId, SubmissionSettlement, TaskId, TaskRecord, Tx } from "../types.ts";
import type { SchedulerOutcome } from "./scheduler.ts";

/** Built-in live conversation state: run control and presentation of the current generation. */
export type LiveState = {
	/** Run control: the task responsible for the run and its placed inputs; present exactly while busy. */
	run?: { taskId: TaskId; inputs: SubmissionId[] };
	/** Presentation of the current generation attempt. */
	generation?: {
		attempt: number;
		/** Committed throttled partial of the in-flight response. */
		message?: JsonRepresentation<AssistantMessage>;
		/** Durable backoff before the next attempt. */
		retry?: { at: number; error: string };
		/** Provider-side deferred response being polled. */
		deferred?: { pollAt: number };
	};
};

export const LiveDoc = defineDoc<LiveState>({
	kind: "pi.live",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({}),
	// A complete base whenever nothing is in flight, so the delta chain spans at most one generation, including its
	// retries and deferred polls, or one tool round.
	checkpointWhen: (value) => value.generation === undefined,
});

/** Built-in task kinds that can own `pi.live.run`. */
const RUN_TASK_KINDS: ReadonlySet<string> = new Set(["pi.generation"]);

/**
 * End the run owned by `taskId`: settle each of its inputs and remove `run`. Always removes `generation`, whose
 * presentation belongs to the ending task.
 */
export function endRun(tx: Tx, live: Draft<LiveState>, taskId: TaskId, settlement: SubmissionSettlement): void {
	if (live.run?.taskId === taskId) {
		for (const id of live.run.inputs) tx.settleSubmission(id, settlement);
		delete live.run;
	}
	delete live.generation;
}

/**
 * Harness cleanup for a terminal outcome the scheduler writes itself (`faulted` or `orphaned`). Ignores non-run task
 * kinds so it never creates `pi.live` elsewhere. Committed partials are discarded without a transcript entry.
 */
export async function settleSchedulerOutcome(
	tx: Transaction,
	record: TaskRecord<JsonValue, JsonValue, JsonValue>,
	outcome: SchedulerOutcome,
): Promise<void> {
	if (!RUN_TASK_KINDS.has(record.kind)) return;
	const live = await tx.doc(LiveDoc, record.conversationId);
	if (live.run?.taskId !== record.id) return;
	endRun(
		tx,
		live,
		record.id,
		outcome.status === "faulted"
			? { status: "unanswered", reason: "faulted", detail: outcome.error.message }
			: { status: "unanswered", reason: outcome.reason },
	);
}
