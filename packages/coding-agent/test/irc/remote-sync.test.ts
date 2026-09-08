import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	initInstanceName,
	instanceIdentity,
	resetInstanceIdentityForTests,
	setInstanceName,
} from "@oh-my-pi/pi-coding-agent/irc/instance";
import { attachCrossProcessIrc } from "@oh-my-pi/pi-coding-agent/irc/remote";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { IrcIncomingNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

/** Copied from test/tools/hub-cross-process.test.ts: a session that reports a fixed delivery outcome. */
function makeFakeSession(outcome: "injected" | "woken"): AgentSession {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		isStreaming: true,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIrcAutoReplies: async () => {},
		deliverIrcMessage: async (_msg: IrcMessage) => outcome,
		emitIrcRelayObservation: (_record: CustomMessage) => {},
	};
	return session as unknown as AgentSession;
}

/** Fake broker whose `irc.sync` blocks until the test releases it; records every requested name. */
function fakeBroker() {
	const requested: string[] = [];
	let gate = Promise.withResolvers<void>();
	let started = Promise.withResolvers<void>();
	let capturedHandlers: daemonClient.IrcAttachHandlers | undefined;
	const client = {
		projectDir: "/tmp",
		onCompletion: () => () => {},
		request: async () => {
			throw new Error("unused");
		},
		close() {},
		attachIrc(handlers: daemonClient.IrcAttachHandlers): daemonClient.IrcAttachment {
			capturedHandlers = handlers;
			return {
				sync: async () => {
					const name = handlers.requestedName();
					requested.push(name);
					started.resolve();
					await gate.promise;
					handlers.nameGranted(name, name);
					return { instance: name, peers: [] };
				},
				list: async () => [],
				send: async () => ({ outcome: "failed" as const, error: "n/a" }),
				detach: async () => {},
			};
		},
	} as unknown as daemonClient.DaemonBrokerClient;
	return {
		client,
		requested,
		release: () => gate.resolve(),
		/** Re-arm so the next `sync` blocks; resolves once that sync has read its name. */
		hold: () => {
			gate = Promise.withResolvers<void>();
			started = Promise.withResolvers<void>();
			return started.promise;
		},
		handlers: () => capturedHandlers,
	};
}

describe("cross-process identity sync", () => {
	beforeEach(() => {
		resetInstanceIdentityForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("a rename during an in-flight sync is pushed afterwards instead of being clobbered by the stale grant", async () => {
		initInstanceName("Alpha");
		const broker = fakeBroker();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker.client);
		broker.release();
		const handle = await attachCrossProcessIrc({
			cwd: "/tmp",
			settings: Settings.isolated(),
			registry: AgentRegistry.global(),
			bus: IrcBus.global(),
		});
		expect(handle).not.toBeNull();

		const inFlightStarted = broker.hold();
		const inFlight = IrcBus.global().syncRemoteIdentity();
		await inFlightStarted;

		setInstanceName("Beta");
		const renameSync = IrcBus.global().syncRemoteIdentity();
		broker.release();
		await inFlight;
		await renameSync;

		expect(broker.requested[0]).toBe("Alpha");
		expect(broker.requested.at(-1)).toBe("Beta");
		expect(instanceIdentity().name).toBe("Beta");
		await handle?.close();
	});

	it("an inbound message that wakes a local agent triggers an immediate resync", async () => {
		initInstanceName("Alpha");
		const broker = fakeBroker();
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(broker.client);
		broker.release();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: makeFakeSession("woken") });
		const handle = await attachCrossProcessIrc({
			cwd: "/tmp",
			settings: Settings.isolated(),
			registry,
			bus: IrcBus.global(),
		});
		expect(handle).not.toBeNull();
		const handlers = broker.handlers();
		if (!handlers) throw new Error("attachIrc was never called");

		// Re-arm the gate so the next `sync()` call blocks; its `started` promise
		// resolves the moment that sync begins, giving a deterministic signal
		// that the wake actually triggered a further `irc.sync` request.
		const nextSyncStarted = broker.hold();
		const notification: IrcIncomingNotification = {
			event: "irc-incoming",
			deliveryId: "d1",
			message: { id: "m1", from: "Other/Peer", to: "Alpha/Main", body: "hi", ts: Date.now() },
			expectsReply: false,
		};
		const receipt = await handlers.incoming(notification);
		expect(receipt.outcome).toBe("woken");

		await nextSyncStarted;
		broker.release();
		expect(broker.requested).toEqual(["Alpha", "Alpha"]);
		await handle?.close();
	});
});
