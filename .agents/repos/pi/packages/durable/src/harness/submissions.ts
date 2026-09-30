import type { Context } from "@earendil-works/chord";
import { UserEntry } from "../entries.ts";
import { ConversationBusy } from "../errors.ts";
import type { SessionImpl } from "../session/session.ts";
import type { CommitPublication, ConversationId, Storage, SubmissionId, SubmissionRecord } from "../types.ts";
import { GenerationTask } from "./generation.ts";
import { LiveDoc } from "./live.ts";
import type { SettledSubmissionRecord, Submission, SubmissionDraft } from "./types.ts";
import { closedError, Waiters } from "./util.ts";

type AbortResult = "aborted" | "already_placed" | "settled";

/** Admission, waits, and withdrawal of the durable submissions of one Harness. */
export class Submissions {
	readonly #session: SessionImpl;
	readonly #storage: Storage;
	readonly #now: () => number;
	/** Enable task scheduling; submitting or waiting asks for progress. */
	readonly #resume: () => void;
	readonly #waiters = new Waiters<SubmissionId, SettledSubmissionRecord>();
	#closed = false;

	constructor(session: SessionImpl, storage: Storage, now: () => number, resume: () => void) {
		this.#session = session;
		this.#storage = storage;
		this.#now = now;
		this.#resume = resume;
		session.subscribeCommits((publication) => this.#observe(publication));
		session.subscribeClose(() => {
			this.#closed = true;
			this.#waiters.rejectAll(closedError());
		});
	}

	/**
	 * Admit a submission in one commit. A known request ID returns its existing submission without writing. Until the
	 * inbox exists, a busy conversation rejects with `ConversationBusy` and writes nothing. Idle input places a user
	 * entry and starts a generation run; an idle write appends its entry and settles `done`.
	 */
	async submit(conversationId: ConversationId, draft: SubmissionDraft, context: Context): Promise<Submission> {
		this.#resume();
		const id = await this.#session.commitWith(async (tx) => {
			if (draft.requestId !== undefined) {
				const existing = await tx.submissionByRequest(conversationId, draft.requestId);
				if (existing !== undefined) {
					if (existing.type !== draft.type) {
						throw new Error(
							`Request ${draft.requestId} already identifies a submission of type ${existing.type}`,
						);
					}
					return existing.id;
				}
			}
			const live = await tx.doc(LiveDoc, conversationId);
			if (live.run !== undefined) throw new ConversationBusy(conversationId);
			const requestId = draft.requestId === undefined ? {} : { requestId: draft.requestId };
			if (draft.type === "write") {
				const entry = await tx.appendEntry(conversationId, draft.entry);
				const write = { conversationId, ...requestId, type: "write", status: "done", entry: entry.id } as const;
				return (await tx.createSubmission(write)).id;
			}
			const message = { role: "user", content: draft.content, timestamp: this.#now() } as const;
			const entry = await tx.appendEntry(UserEntry, conversationId, { model: [message] });
			const input = { conversationId, ...requestId, type: "input", status: "placed", entry: entry.id } as const;
			const { id } = await tx.createSubmission(input);
			live.run = { taskId: await tx.createTask(GenerationTask, {}, { conversationId }), inputs: [id] };
			return id;
		}, context);
		return new SubmissionHandle(id, this);
	}

	/** Handle for an existing submission, or `undefined`. */
	async get(id: SubmissionId, context: Context): Promise<Submission | undefined> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		return record === undefined ? undefined : new SubmissionHandle(record.id, this);
	}

	async status(id: SubmissionId, context: Context): Promise<SubmissionRecord> {
		const record = await this.#session.readOnLine(() => this.#storage.submission(id, context));
		if (record === undefined) throw new Error(`Submission ${id} does not exist`);
		return record;
	}

	async wait(id: SubmissionId, context: Context): Promise<SettledSubmissionRecord> {
		this.#resume();
		// Check and register on the line so no settling publication falls between them.
		const found = await this.#session.readOnLine(async () => {
			const record = await this.#storage.submission(id, context);
			if (record === undefined) throw new Error(`Submission ${id} does not exist`);
			if (isSettled(record)) return { promise: Promise.resolve(record) };
			// Close rejects registered waiters synchronously and may begin during the read.
			if (this.#closed) throw closedError();
			return { promise: this.#waiters.add(id, context) };
		});
		return found.promise;
	}

	/** Withdraw a queued submission; placed inputs and settled submissions are reported, not changed. */
	abort(id: SubmissionId, context: Context, conversationId?: ConversationId): Promise<AbortResult | "not_found"> {
		return this.#session.commitWith(async (tx) => {
			const record = await tx.submission(id);
			if (record === undefined || (conversationId !== undefined && record.conversationId !== conversationId)) {
				return "not_found";
			}
			if (record.status === "queued") {
				tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
				return "aborted";
			}
			return record.status === "placed" ? "already_placed" : "settled";
		}, context);
	}

	#observe(publication: CommitPublication): void {
		for (const change of publication.changes) {
			if (change.type !== "submission" || !isSettled(change.value)) continue;
			this.#waiters.resolve(change.value.id, change.value);
		}
	}
}

class SubmissionHandle implements Submission {
	readonly id: SubmissionId;
	readonly #submissions: Submissions;

	constructor(id: SubmissionId, submissions: Submissions) {
		this.id = id;
		this.#submissions = submissions;
	}

	status(context: Context): Promise<SubmissionRecord> {
		return this.#submissions.status(this.id, context);
	}

	wait(context: Context): Promise<SettledSubmissionRecord> {
		return this.#submissions.wait(this.id, context);
	}

	async abort(context: Context): Promise<AbortResult> {
		const result = await this.#submissions.abort(this.id, context);
		if (result === "not_found") throw new Error(`Submission ${this.id} does not exist`);
		return result;
	}
}

function isSettled(record: SubmissionRecord): record is SettledSubmissionRecord {
	return record.status === "done" || record.status === "unanswered";
}
