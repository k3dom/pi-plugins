import { type Context, copyJson, type Draft, type JsonValue } from "@earendil-works/chord";
import {
	type Api,
	type AssistantMessage,
	type DeferredHandle,
	isRetryableAssistantError,
	type Message,
	type Model,
	type ModelThinkingLevel,
	retryDelayMs,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { AssistantEntry, SystemEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type { ConversationId, EntryId, NextTaskState, TaskRuntime, Tx } from "../types.ts";
import { ConversationConfig, DEFAULT_RETRY_POLICY } from "./config.ts";
import { endRun, LiveDoc, type LiveState } from "./live.ts";
import { planSystemEntries, renderSections, replaySections } from "./prompt.ts";
import type { ConversationStreamOptions, ModelRef } from "./types.ts";

export type GenerationInput = Record<string, never>;

export type GenerationCheckpoint =
	| { phase: "prepare"; attempt: number }
	| {
			phase: "request";
			attempt: number;
			model: ModelRef;
			thinkingLevel: ModelThinkingLevel;
			/** Configured request options when preparation committed; a resend after recovery uses them unchanged. */
			streamOptions: ConversationStreamOptions;
			/** Newest entry included in the request. */
			cutoff: EntryId;
	  }
	| { phase: "retry"; attempt: number; until: number }
	| { phase: "poll"; attempt: number; model: ModelRef; handle: DeferredHandle; pollAt: number };

export type GenerationResult = { entryId: EntryId };

type Runtime = TaskRuntime<GenerationInput, GenerationCheckpoint, GenerationResult, object>;
type Next = NextTaskState<GenerationCheckpoint, GenerationResult>;

const PARTIAL_THROTTLE_MS = 100;
const DEFAULT_POLL_AFTER_MS = 5000;

/**
 * Built-in generation task: prepares the positional system prompt, requests or polls the model, retries, and classifies
 * the response. The run's inputs live in `pi.live.run`.
 */
export const GenerationTask = defineTask<GenerationInput, GenerationCheckpoint, GenerationResult>({
	name: "pi.generation",
	version: 1,
	initial: () => ({ phase: "prepare", attempt: 1 }),
	phases: {
		/**
		 * Render the system prompt and append the positional `pi.system` entries it needs, then move to `request`. Only
		 * the Harness writes to a busy conversation, so the transcript read here is still the tail at the commit.
		 */
		prepare: async (task, runtime, context) => {
			const { conversationId, registry } = runtime;
			for (const failure of registry.failures()) if (failure.kind === "section") runtime.report(failure.error);
			const { model, thinkingLevel, streamOptions } =
				(await runtime.snapshot(ConversationConfig, conversationId, context)) ??
				ConversationConfig.definition.initial();
			if (model === undefined || runtime.models.getModel(model.provider, model.modelId) === undefined) {
				return failNoModel(runtime, model, context);
			}
			const view = await runtime.context(conversationId, context);
			const shown = replaySections(view.messages);
			const input = {
				conversationId,
				tools: [],
				shown: Object.fromEntries(shown),
				model,
				thinkingLevel,
				read: runtime,
			};
			const report = (error: unknown) => runtime.report(error);
			const desired = await renderSections(registry.sections(), input, shown, report, context);
			const entries = planSystemEntries(view, desired, runtime.now());
			await runtime.commit(async (tx) => {
				let cutoff = (await tx.scanEntries({ conversationId }, 1)).items[0]?.id;
				for (const entry of entries) cutoff = (await tx.appendEntry(SystemEntry, conversationId, entry)).id;
				if (cutoff === undefined) throw new Error(`Conversation ${conversationId} has no entries to send`);
				const { attempt } = task.state.checkpoint;
				const request = { attempt, model, thinkingLevel, streamOptions: streamOptions ?? {}, cutoff };
				return { status: "running", checkpoint: { phase: "request", ...request } };
			}, context);
		},
		request: async (task, runtime, context) => {
			const { attempt, model: ref, thinkingLevel, streamOptions, cutoff } = task.state.checkpoint;
			const conversationId = runtime.conversationId;
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, conversationId);
				await convertPartial(tx, live, conversationId);
				live.generation = { attempt };
				return undefined;
			}, context);
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			const view = await runtime.context(conversationId, context, cutoff);
			const options: SimpleStreamOptions = {
				...streamOptions,
				signal: runtime.signal,
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const message = await streamResponse(runtime, model, view.messages, options, attempt, context);
			await classify(runtime, attempt, ref, undefined, message, context);
		},
		retry: async (task, runtime, context) => {
			const { attempt, until } = task.state.checkpoint;
			await runtime.sleep(until, context);
			await runtime.commit(async (tx) => {
				(await tx.doc(LiveDoc, runtime.conversationId)).generation = { attempt: attempt + 1 };
				return { status: "running", checkpoint: { phase: "prepare", attempt: attempt + 1 } };
			}, context);
		},
		poll: async (task, runtime, context) => {
			const { attempt, model: ref, handle, pollAt } = task.state.checkpoint;
			const model = runtime.models.getModel(ref.provider, ref.modelId);
			if (model === undefined) return failNoModel(runtime, ref, context);
			await runtime.sleep(pollAt, context);
			const message = await runtime.models.fetchDeferred(model, handle, { signal: runtime.signal });
			await classify(runtime, attempt, ref, pollAt, message, context);
		},
	},
	abort: async (task, runtime, context) => {
		const checkpoint = task.state.checkpoint;
		if (checkpoint.phase === "poll") {
			const model = runtime.models.getModel(checkpoint.model.provider, checkpoint.model.modelId);
			if (model !== undefined) {
				try {
					await runtime.models.cancelDeferred(model, checkpoint.handle, { signal: runtime.signal });
				} catch (error) {
					runtime.report(error);
				}
			}
		}
		const conversationId = runtime.conversationId;
		await runtime.commit(async (tx) => {
			const live = await tx.doc(LiveDoc, conversationId);
			await convertPartial(tx, live, conversationId);
			endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "aborted" });
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Settle the run's inputs `unanswered` with `no_model` and fail. */
async function failNoModel(runtime: Runtime, ref: ModelRef | undefined, context: Context): Promise<void> {
	const message =
		ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
	await runtime.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, runtime.conversationId);
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "no_model" });
		return { status: "terminal", outcome: { status: "failed", error: { message, detail: { reason: "no_model" } } } };
	}, context);
}

/** Append a committed partial left by an interrupted attempt as an aborted assistant entry; the caller replaces `generation`. */
async function convertPartial(tx: Tx, live: Draft<LiveState>, conversationId: ConversationId): Promise<void> {
	const partial = live.generation?.message;
	if (partial === undefined) return;
	const message = copyJson(partial) as unknown as AssistantMessage;
	await tx.appendEntry(AssistantEntry, conversationId, { model: [{ ...message, stopReason: "aborted" }] });
}

/**
 * Stream one request and return the terminal message. Partials commit as trailing writes at most every 100 ms with one
 * commit in flight; `finally` stops the throttle and awaits that commit, so no stale partial lands after the outcome.
 */
async function streamResponse(
	runtime: Runtime,
	model: Model<Api>,
	messages: readonly Message[],
	options: SimpleStreamOptions,
	attempt: number,
	context: Context,
): Promise<AssistantMessage> {
	let pending: AssistantMessage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | undefined;
	let stopped = false;
	const flush = (): void => {
		timer = undefined;
		const partial = pending;
		pending = undefined;
		if (partial === undefined || stopped) return;
		inFlight = (async () => {
			// Copy synchronously: the provider keeps mutating its partial.
			const message = copyJson(partial, { omitUndefinedProperties: true });
			await runtime.commit(async (tx) => {
				const live = await tx.doc(LiveDoc, runtime.conversationId);
				live.generation ??= { attempt };
				assignJson(live.generation as Draft<Record<string, JsonValue>>, "message", message);
				return undefined;
			}, context);
		})()
			.catch((error: unknown) => {
				// Rejections after an abort mark or close are expected; the committed state stays consistent.
				if (!runtime.signal.aborted) runtime.report(error);
			})
			.finally(() => {
				inFlight = undefined;
				if (pending !== undefined && !stopped) timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
			});
	};
	try {
		const events = runtime.models.streamSimple(model, { messages: [...messages] }, options);
		for await (const event of events) {
			if (event.type === "done" || event.type === "error") continue;
			pending = event.partial;
			if (timer === undefined && inFlight === undefined) timer = setTimeout(flush, PARTIAL_THROTTLE_MS);
		}
		return await events.result();
	} finally {
		stopped = true;
		clearTimeout(timer);
		await inFlight;
	}
}

/**
 * Classify a terminal provider message in one commit that also clears the partial. `previousPollAt` is set when the
 * message came from polling, so a still deferred result polls strictly later.
 */
async function classify(
	runtime: Runtime,
	attempt: number,
	ref: ModelRef,
	previousPollAt: number | undefined,
	message: AssistantMessage,
	context: Context,
): Promise<void> {
	// An abort mark or close: the abort invocation or the reopened run handles the committed state.
	runtime.signal.throwIfAborted();
	const conversationId = runtime.conversationId;
	if (message.stopReason === "deferred" && message.deferred !== undefined) {
		const handle = message.deferred;
		const pollAt = Math.max(
			runtime.now() + (handle.pollAfterMs ?? DEFAULT_POLL_AFTER_MS),
			previousPollAt === undefined ? Number.NEGATIVE_INFINITY : previousPollAt + 1,
		);
		await runtime.commit(async (tx) => {
			(await tx.doc(LiveDoc, conversationId)).generation = { attempt, deferred: { pollAt } };
			return { status: "running", checkpoint: { phase: "poll", attempt, model: ref, handle, pollAt } };
		}, context);
		return;
	}
	const policy = (await runtime.snapshot(ConversationConfig, conversationId, context))?.retry ?? DEFAULT_RETRY_POLICY;
	const retry =
		message.stopReason === "error" &&
		isRetryableAssistantError(message) &&
		policy.enabled &&
		attempt <= policy.maxRetries;
	const until = retry ? runtime.now() + retryDelayMs(policy, attempt) : 0;
	await runtime.commit(async (tx): Promise<Next> => {
		const live = await tx.doc(LiveDoc, conversationId);
		const entry = await tx.appendEntry(AssistantEntry, conversationId, { model: [message] });
		switch (message.stopReason) {
			case "stop":
			case "length":
			// Until the tool chain exists, a tool call settles as the answer.
			case "toolUse":
				endRun(tx, live, runtime.taskId, { status: "done", answer: entry.id });
				return { status: "terminal", outcome: { status: "completed", result: { entryId: entry.id } } };
		}
		if (retry) {
			live.generation = { attempt, retry: { at: until, error: message.errorMessage ?? "" } };
			return { status: "running", checkpoint: { phase: "retry", attempt, until } };
		}
		const text = message.errorMessage ?? `Model response ended with stop reason ${message.stopReason}`;
		endRun(tx, live, runtime.taskId, { status: "unanswered", reason: "model_error", detail: text });
		return {
			status: "terminal",
			outcome: { status: "failed", error: { message: text, detail: { reason: "model_error" } } },
		};
	}, context);
}

type JsonContainer = Record<string, JsonValue> | JsonValue[];

/**
 * Assign `value` at `target[key]` leaf by leaf. Chord records a container assignment as one full set and only emits an
 * append when a string leaf is reassigned with a longer string, so writing the partial whole would store and publish the
 * complete message on every flush.
 */
function assignJson(target: JsonContainer, key: string | number, value: JsonValue): void {
	const slots = target as Record<string | number, JsonValue>;
	const current = slots[key];
	if (isRecord(current) && isRecord(value)) {
		for (const name of Object.keys(current)) if (!Object.hasOwn(value, name)) delete current[name];
		for (const [name, child] of Object.entries(value)) assignJson(current, name, child);
		return;
	}
	if (Array.isArray(current) && Array.isArray(value) && current.length <= value.length) {
		const items = current as JsonValue[];
		for (let index = 0; index < value.length; index++) {
			if (index < items.length) assignJson(items, index, value[index]!);
			else items.push(value[index]!);
		}
		return;
	}
	if (current !== value) slots[key] = value;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
