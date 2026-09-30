import type { Context } from "@earendil-works/chord";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { SystemEntry } from "../entries.ts";
import type { ContextEdit, TypedEntryDraft } from "../types.ts";
import type { ContextView, PromptInput, PromptSection, ToolRegistration } from "./types.ts";

/** Sections in effect after replaying system messages in order: set in place, `null` deletes, re-adding appends. */
export function replaySections(messages: readonly Message[]): Map<string, string> {
	const shown = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system" || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
	}
	return shown;
}

/**
 * Render sections in registry order. `undefined` omits a section; tagged text is wrapped as `<key>\n...\n</key>`. A
 * section that throws keeps its shown text, if any, and is reported; errors after `context` is aborted propagate.
 */
export async function renderSections<Tool extends ToolRegistration>(
	sections: readonly PromptSection<Tool>[],
	input: PromptInput<Tool>,
	shown: ReadonlyMap<string, string>,
	report: (error: unknown) => void,
	context: Context,
): Promise<Map<string, string>> {
	const desired = new Map<string, string>();
	for (const section of sections) {
		let text: string | undefined;
		try {
			text = await section.render(input, context);
		} catch (error) {
			if (context.abortSignal?.aborted) throw error;
			report(error);
			const kept = shown.get(section.key);
			if (kept !== undefined) desired.set(section.key, kept);
			continue;
		}
		if (text === undefined) continue;
		desired.set(section.key, section.tag === false ? text : `<${section.key}>\n${text}\n</${section.key}>`);
	}
	return desired;
}

type SystemDraft = TypedEntryDraft<never>;

/**
 * Plan the `pi.system` entries that make the replayed sections of `view` equal `desired` in values and order.
 *
 * - A head marker with no later `pi.system` entry in context: one complete baseline that omits every retained earlier
 *   `pi.system` entry, written even when it restates the replayed values.
 * - Otherwise, when a minimal patch would leave a different order: remove every shown section, then re-add every
 *   desired section in order.
 * - Otherwise the minimal patch of changed values and `null` removals, or nothing.
 */
export function planSystemEntries(
	view: ContextView,
	desired: ReadonlyMap<string, string>,
	timestamp: number,
): SystemDraft[] {
	const head = view.head;
	if (head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > head.id)) {
		const edits: ContextEdit[] = view.entries
			.filter((entry) => SystemEntry.is(entry))
			.map((entry) => ({ target: entry.id, action: "omit" }));
		const baseline = systemEntry(Object.fromEntries(desired), timestamp);
		return [edits.length === 0 ? baseline : { ...baseline, edits }];
	}

	const shown = replaySections(view.messages);
	const patchedOrder = [
		...[...shown.keys()].filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	const desiredOrder = [...desired.keys()];
	if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
		return [
			systemEntry(Object.fromEntries([...shown.keys()].map((key) => [key, null])), timestamp),
			systemEntry(Object.fromEntries(desired), timestamp),
		];
	}

	const patch: Record<string, string | null> = {};
	for (const [key, value] of shown) {
		const next = desired.get(key);
		if (next !== value) patch[key] = next ?? null;
	}
	for (const [key, value] of desired) if (!shown.has(key)) patch[key] = value;
	return Object.keys(patch).length === 0 ? [] : [systemEntry(patch, timestamp)];
}

function systemEntry(sections: Record<string, string | null>, timestamp: number): SystemDraft {
	const message: SystemMessage = { role: "system", content: "", sections, timestamp };
	return { model: [message] };
}
