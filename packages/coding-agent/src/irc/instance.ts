import { generateTaskName } from "../task/name-generator";

export interface InstanceIdentity {
	/** Immutable wire identity; survives renames. */
	readonly token: string;
	/** Human-readable granted name peers address as `<name>/<agent-id>`. */
	readonly name: string;
	/** Name currently requested from the broker; may differ from the granted `name` after a suffix collision. */
	readonly requested: string;
}

interface MutableIdentity {
	token: string;
	requested: string;
	granted: string;
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
		const name = generateTaskName();
		identity = { token: crypto.randomUUID(), requested: name, granted: name };
	}
	return { token: identity.token, name: identity.granted, requested: identity.requested };
}

/** Strip to `[A-Za-z0-9_-]`, cap at 48 chars; undefined when nothing survives. */
export function sanitizeInstanceName(value: string | undefined): string | undefined {
	const sanitized = value?.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 48);
	return sanitized || undefined;
}

/**
 * Seed the name at startup from `--name`, else generate one. A requested name
 * still wins if something already created the identity lazily.
 */
export function initInstanceName(requested?: string): string {
	const sanitized = sanitizeInstanceName(requested);
	if (identity !== undefined) return sanitized === undefined ? identity.granted : setInstanceName(sanitized);
	const name = sanitized ?? generateTaskName();
	identity = { token: crypto.randomUUID(), requested: name, granted: name };
	return identity.granted;
}

/** Sanitize and apply a new name; notifies listeners so an attached bridge re-syncs. Throws when nothing survives sanitizing. */
export function setInstanceName(requested: string): string {
	const sanitized = sanitizeInstanceName(requested);
	if (sanitized === undefined) {
		throw new Error("Instance name must be 1-48 letters, numbers, underscores, or hyphens");
	}
	const current = instanceIdentity();
	if (sanitized === current.name) return current.name;
	identity = { token: current.token, requested: sanitized, granted: sanitized };
	notify(sanitized);
	return sanitized;
}

/**
 * Record the broker's grant for `requested` without notifying (that would
 * loop back into a sync). Ignored when the name changed while the request was
 * in flight: the rename's own sync carries the current name.
 */
export function adoptGrantedInstanceName(requested: string, granted: string): void {
	const current = instanceIdentity();
	if (current.requested !== requested) return;
	identity = { token: current.token, requested: current.requested, granted };
}

export function onInstanceNameChanged(listener: (name: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Reset the instance identity. Test-only. */
export function resetInstanceIdentityForTests(): void {
	identity = undefined;
	listeners.clear();
}
