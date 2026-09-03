import { generateTaskName } from "../task/name-generator";

/** Stable per-process identity for cross-process hub messaging. */
export interface InstanceIdentity {
	/** Immutable wire identity; survives renames. */
	readonly token: string;
	/** Human-readable name peers address as `<name>/<agent-id>`. */
	readonly name: string;
}

interface MutableIdentity {
	token: string;
	name: string;
}

let identity: MutableIdentity | undefined;
const listeners = new Set<(name: string) => void>();

function notify(name: string): void {
	for (const listener of listeners) {
		try {
			listener(name);
		} catch {
			// Listener failures must not break identity mutation.
		}
	}
}

/** Lazily created; `token` is a `crypto.randomUUID()`, `name` a generated pair. */
export function instanceIdentity(): InstanceIdentity {
	if (identity === undefined) {
		identity = { token: crypto.randomUUID(), name: generateTaskName() };
	}
	return identity;
}

/** Strip to `[A-Za-z0-9_-]`, cap at 48 chars; undefined when nothing survives. */
export function sanitizeInstanceName(value: string | undefined): string | undefined {
	const sanitized = value?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || undefined;
}

/** Seed the name once at startup from `--name`, else generate one. Idempotent. */
export function initInstanceName(requested?: string): string {
	if (identity !== undefined) return identity.name;
	const sanitized = sanitizeInstanceName(requested);
	identity = { token: crypto.randomUUID(), name: sanitized ?? generateTaskName() };
	return identity.name;
}

/**
 * Request a new name; notifies listeners so an attached bridge re-syncs.
 *
 * Callers (e.g. the `/peer` slash command) are expected to have already
 * validated the input with {@link sanitizeInstanceName} and only pass a
 * value that sanitizes to a non-empty string. As a defensive guard, an
 * input that sanitizes away entirely throws rather than silently no-op'ing.
 */
export function setInstanceName(requested: string): string {
	const sanitized = sanitizeInstanceName(requested);
	if (sanitized === undefined) {
		throw new Error("Instance name must be 1-48 letters, numbers, underscores, or hyphens");
	}
	const current = instanceIdentity();
	if (sanitized === current.name) return current.name;
	identity = { token: current.token, name: sanitized };
	notify(sanitized);
	return sanitized;
}

/** Record the broker-granted name WITHOUT notifying (prevents a sync loop). */
export function adoptGrantedInstanceName(name: string): void {
	const current = instanceIdentity();
	identity = { token: current.token, name };
}

export function onInstanceNameChanged(listener: (name: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Test hook: drop the singleton so each test starts from a known identity. */
export function resetInstanceIdentityForTests(): void {
	identity = undefined;
	listeners.clear();
}
