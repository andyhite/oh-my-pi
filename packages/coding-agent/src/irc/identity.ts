import type { AgentRegistry } from "../registry/agent-registry";

export const IRC_ID_SEPARATOR = "/";

/** `<instance>/<id>`. */
export function qualifyIrcId(instance: string, id: string): string {
	return `${instance}${IRC_ID_SEPARATOR}${id}`;
}

/** Split at the FIRST separator; `instance` is undefined for a bare id. */
export function parseIrcId(value: string): { instance?: string; id: string } {
	const idx = value.indexOf(IRC_ID_SEPARATOR);
	if (idx === -1) return { id: value };
	return { instance: value.slice(0, idx), id: value.slice(idx + 1) };
}

export function isQualifiedIrcId(value: string): boolean {
	return value.includes(IRC_ID_SEPARATOR);
}

/** Where a `to`/`from` string points, once local refs and the overlay are consulted. */
export type PeerTarget =
	| { kind: "broadcast" }
	| { kind: "local"; id: string }
	| { kind: "remote"; id: string; instance: string; localId: string }
	| { kind: "ambiguous"; id: string; candidates: string[] }
	| { kind: "unknown"; id: string };

/**
 * Resolve an addressed peer. `localInstance` is this process's granted instance
 * name, or undefined when it has no cross-process transport — which makes every
 * bare id resolve exactly as it does today.
 */
export function resolvePeerTarget(
	registry: AgentRegistry,
	input: string,
	localInstance: string | undefined,
): PeerTarget {
	if (input === "all") return { kind: "broadcast" };

	if (isQualifiedIrcId(input)) {
		const { instance, id } = parseIrcId(input);
		if (instance === localInstance) return { kind: "local", id };
		const peer = registry.getRemotePeer(input);
		if (!peer) return { kind: "unknown", id: input };
		return { kind: "remote", id: input, instance: peer.instance, localId: peer.localId };
	}

	if (registry.get(input)) return { kind: "local", id: input };

	const matches = registry.listRemotePeers().filter(peer => peer.localId === input);
	if (matches.length === 1) {
		const match = matches[0]!;
		return { kind: "remote", id: match.id, instance: match.instance, localId: input };
	}
	if (matches.length > 1) {
		return { kind: "ambiguous", id: input, candidates: matches.map(m => m.id).sort() };
	}
	return { kind: "unknown", id: input };
}
