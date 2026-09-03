/**
 * Cross-process hub messaging — bus + tool level coverage using a
 * hand-written IrcRemoteTransport (no `mock.module`). Exercises peer
 * resolution (local/remote/ambiguous/unknown), the merged `list` roster,
 * inbound delivery via `deliverIncoming`, remote-aware `wait` liveness, and
 * transport failure passthrough — plus a no-transport regression guard.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	IrcBus,
	type IrcDeliveryReceipt,
	type IrcMessage,
	type IrcRemoteTransport,
} from "@oh-my-pi/pi-coding-agent/irc/bus";
import { qualifyIrcId } from "@oh-my-pi/pi-coding-agent/irc/identity";
import { resetInstanceIdentityForTests } from "@oh-my-pi/pi-coding-agent/irc/instance";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type RemoteAgentPeer } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { executeList, executeMessageWait, executeSend } from "@oh-my-pi/pi-coding-agent/tools/hub/messaging";

const SELF_INSTANCE = "SelfInstance";

interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
	setOutcome: (outcome: "injected" | "woken") => void;
}

function makeFakeSession(): FakeSession {
	let outcome: "injected" | "woken" = "injected";
	const delivered: IrcMessage[] = [];
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		isStreaming: true,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIrcAutoReplies: async () => {},
		deliverIrcMessage: async (msg: IrcMessage) => {
			delivered.push(msg);
			return outcome;
		},
		emitIrcRelayObservation: (_record: CustomMessage) => {},
	};
	return {
		session: session as unknown as AgentSession,
		delivered,
		setOutcome: value => {
			outcome = value;
		},
	};
}

/** Hand-written transport; captures every `send` call for assertion. */
function makeTransport(overrides?: Partial<IrcRemoteTransport>): {
	transport: IrcRemoteTransport;
	sendCalls: Array<{ message: IrcMessage; target: { instance: string; id: string } }>;
} {
	const sendCalls: Array<{ message: IrcMessage; target: { instance: string; id: string } }> = [];
	const transport: IrcRemoteTransport = {
		instance: SELF_INSTANCE,
		send: async (message, target) => {
			sendCalls.push({ message, target });
			return { to: qualifyIrcId(target.instance, target.id), outcome: "injected" } satisfies IrcDeliveryReceipt;
		},
		refresh: async () => {},
		syncIdentity: async () => {},
		...overrides,
	};
	return { transport, sendCalls };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content[0];
	if (content?.type !== "text" || typeof content.text !== "string") throw new Error("Expected text result");
	return content.text;
}

function makeRemotePeer(overrides: Partial<RemoteAgentPeer> & { instance: string; localId: string }): RemoteAgentPeer {
	return {
		id: qualifyIrcId(overrides.instance, overrides.localId),
		displayName: overrides.localId,
		kind: "sub",
		status: "running",
		live: true,
		lastActivity: Date.now(),
		...overrides,
	};
}

describe("cross-process hub messaging", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		resetInstanceIdentityForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	describe("peer resolution", () => {
		it("routes a bare unique remote id to the transport with a qualified `to`", async () => {
			const { transport, sendCalls } = makeTransport();
			bus.attachRemote(transport);
			registry.setRemotePeers([makeRemotePeer({ instance: "Other", localId: "Worker" })]);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: "Worker", message: "hi" },
			);

			expect(sendCalls).toHaveLength(1);
			expect(sendCalls[0]?.target).toEqual({ instance: "Other", id: "Worker" });
			expect(result.isError).toBeFalsy();
			expect(textOf(result)).toContain("Other/Worker: injected");
		});

		it("reports every qualified candidate for a bare ambiguous id", async () => {
			const { transport, sendCalls } = makeTransport();
			bus.attachRemote(transport);
			registry.setRemotePeers([
				makeRemotePeer({ instance: "Alpha", localId: "Worker" }),
				makeRemotePeer({ instance: "Beta", localId: "Worker" }),
			]);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: "Worker", message: "hi" },
			);

			expect(sendCalls).toHaveLength(0);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toBe(
				'Ambiguous peer "Worker" — 2 omp processes advertise it: Alpha/Worker, Beta/Worker. Address one explicitly.',
			);
		});

		it("delivers an own-instance qualified id locally without touching the transport", async () => {
			const { transport, sendCalls } = makeTransport();
			bus.attachRemote(transport);
			registry.setRemotePeers([]);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			const sub = makeFakeSession();
			sub.setOutcome("injected");
			registry.register({ id: "Sub", displayName: "task", kind: "sub", session: sub.session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: `${SELF_INSTANCE}/Sub`, message: "hi" },
			);

			expect(sendCalls).toHaveLength(0);
			expect(result.isError).toBeFalsy();
			expect(sub.delivered).toHaveLength(1);
			expect(sub.delivered[0]?.body).toBe("hi");
		});

		it("still produces today's exact unknown-agent text for a nonexistent bare id (local-only regression)", async () => {
			const { transport, sendCalls } = makeTransport();
			bus.attachRemote(transport);
			registry.setRemotePeers([]);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: "Nobody", message: "hi" },
			);

			expect(sendCalls).toHaveLength(0);
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain('Unknown agent "Nobody" — check `irc list` for live peers.');
		});
	});

	describe("list merge", () => {
		it("merges local and remote rows, tallies remote count, and names this instance", async () => {
			const { transport } = makeTransport();
			bus.attachRemote(transport);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			registry.register({ id: "Sub", displayName: "task", kind: "sub", session: makeFakeSession().session });
			registry.setRemotePeers([
				makeRemotePeer({ instance: "Alpha", localId: "Worker" }),
				makeRemotePeer({ instance: "Alpha", localId: "Helper", status: "idle" }),
			]);

			const result = await executeList(registry, "Main");
			const text = textOf(result);

			expect(text).toContain(
				`You are \`${SELF_INSTANCE}\` — peers address your agents as \`${SELF_INSTANCE}/<agent-id>\`.`,
			);
			expect(text).toContain("Sub");
			expect(text).toContain("Alpha/Worker");
			expect(text).toContain("Alpha/Helper");
			expect(result.details && "counts" in result.details ? result.details.counts?.remote : undefined).toBe(2);
			const peers = result.details && "peers" in result.details ? result.details.peers : undefined;
			expect(peers?.some(p => p.id === "Alpha/Worker" && p.remote === true && p.instance === "Alpha")).toBe(true);
			expect(peers?.some(p => p.id === "Sub" && !p.remote)).toBe(true);
		});
	});

	describe("inbound delivery", () => {
		it("resolves a parked local waiter with a qualified from and bare to", async () => {
			const { transport } = makeTransport();
			bus.attachRemote(transport);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			registry.register({ id: "Alpha", displayName: "task", kind: "sub", session: makeFakeSession().session });

			const waiting = bus.wait("Alpha", {}, 5000);
			const inbound: IrcMessage = {
				id: "m1",
				from: "Beta/Main",
				to: `${SELF_INSTANCE}/Alpha`,
				body: "hello",
				ts: Date.now(),
			};
			const receipt = await bus.deliverIncoming(inbound);
			expect(receipt.outcome).toBe("injected");

			const resolved = await waiting;
			expect(resolved?.from).toBe("Beta/Main");
			expect(resolved?.to).toBe("Alpha");
		});

		it("routes to the session's deliverIrcMessage with no waiter registered", async () => {
			const { transport } = makeTransport();
			bus.attachRemote(transport);
			const fake = makeFakeSession();
			fake.setOutcome("woken");
			registry.register({ id: "Alpha", displayName: "task", kind: "sub", session: fake.session, status: "idle" });

			const inbound: IrcMessage = {
				id: "m2",
				from: "Beta/Main",
				to: `${SELF_INSTANCE}/Alpha`,
				body: "no waiter here",
				ts: Date.now(),
			};
			const receipt = await bus.deliverIncoming(inbound);

			expect(receipt.outcome).toBe("woken");
			expect(fake.delivered).toHaveLength(1);
			expect(fake.delivered[0]?.to).toBe("Alpha");
			expect(fake.delivered[0]?.from).toBe("Beta/Main");
		});
	});

	describe("remote-aware wait liveness", () => {
		it("parks while the overlay reports the remote peer running, and resolves on deliverIncoming", async () => {
			const { transport } = makeTransport();
			bus.attachRemote(transport);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			registry.setRemotePeers([
				makeRemotePeer({ instance: "Beta", localId: "Main", status: "running", live: true }),
			]);

			// `executeMessageWait` runs synchronously up to its first internal
			// `await` (the `bus.wait` call, whose own waiter registration is
			// itself synchronous), so by the time this call returns control the
			// waiter is already parked — no real-time wait needed before delivery.
			const waiting = executeMessageWait(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ from: "Beta/Main", timeoutMs: 5000 },
			);

			const inbound: IrcMessage = {
				id: "m3",
				from: "Beta/Main",
				to: `${SELF_INSTANCE}/Main`,
				body: "reply",
				ts: Date.now(),
			};
			await bus.deliverIncoming(inbound);

			const result = await waiting;
			expect(result.isError).toBeFalsy();
			const waited = result.details && "waited" in result.details ? result.details.waited : undefined;
			expect(waited?.body).toBe("reply");
			expect(waited?.from).toBe("Beta/Main");
		});

		it("aborts with a not-running reason once the peer leaves the overlay", async () => {
			const { transport } = makeTransport();
			bus.attachRemote(transport);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			registry.setRemotePeers([
				makeRemotePeer({ instance: "Beta", localId: "Main", status: "running", live: true }),
			]);

			const waiting = executeMessageWait(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ from: "Beta/Main", timeoutMs: 5000 },
			);

			registry.setRemotePeers([]);

			const result = await waiting;
			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("not running");
		});
	});

	describe("failure passthrough", () => {
		it("surfaces a failed transport receipt as an error result with the verbatim text", async () => {
			const { transport } = makeTransport({
				send: async (_message, target) => ({
					to: qualifyIrcId(target.instance, target.id),
					outcome: "failed",
					error: "peer unreachable: some error text",
				}),
			});
			bus.attachRemote(transport);
			registry.setRemotePeers([makeRemotePeer({ instance: "Other", localId: "Worker" })]);
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: "Worker", message: "hi" },
			);

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("peer unreachable: some error text");
		});
	});

	describe("no transport attached (local-only regression)", () => {
		it("send behaves exactly as before: no remote rows, no attempt to reach a transport", async () => {
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			const sub = makeFakeSession();
			registry.register({ id: "Sub", displayName: "task", kind: "sub", session: sub.session });

			const result = await executeSend(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ to: "Sub", message: "local only" },
			);

			expect(result.isError).toBeFalsy();
			expect(sub.delivered).toHaveLength(1);
		});

		it("list has no remote rows, no remote tally, and no self-name line", async () => {
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			registry.register({ id: "Sub", displayName: "task", kind: "sub", session: makeFakeSession().session });

			const result = await executeList(registry, "Main");
			const text = textOf(result);

			expect(text).not.toContain("You are `");
			expect(result.details && "counts" in result.details ? result.details.counts?.remote : undefined).toBe(0);
			const peers = result.details && "peers" in result.details ? result.details.peers : undefined;
			expect(peers?.every(p => !p.remote)).toBe(true);
		});

		it("wait behaves exactly as before with no overlay involvement", async () => {
			registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession().session });
			const sub = makeFakeSession();
			registry.register({ id: "Sub", displayName: "task", kind: "sub", session: sub.session, status: "running" });

			const waiting = executeMessageWait(
				{ registry, senderId: "Main", settings: Settings.isolated() },
				{ from: "Sub", timeoutMs: 1000 },
			);
			await bus.send({ from: "Sub", to: "Main", body: "pong" });

			const result = await waiting;
			expect(result.isError).toBeFalsy();
			const waited = result.details && "waited" in result.details ? result.details.waited : undefined;
			expect(waited?.body).toBe("pong");
		});
	});
});
