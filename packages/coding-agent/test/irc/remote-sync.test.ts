import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import {
	initInstanceName,
	instanceIdentity,
	resetInstanceIdentityForTests,
	setInstanceName,
} from "@oh-my-pi/pi-coding-agent/irc/instance";
import { attachCrossProcessIrc } from "@oh-my-pi/pi-coding-agent/irc/remote";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

/** Fake broker whose `irc.sync` blocks until the test releases it; records every requested name. */
function fakeBroker() {
	const requested: string[] = [];
	let gate = Promise.withResolvers<void>();
	let started = Promise.withResolvers<void>();
	const client = {
		projectDir: "/tmp",
		onCompletion: () => () => {},
		request: async () => {
			throw new Error("unused");
		},
		close() {},
		attachIrc(handlers: daemonClient.IrcAttachHandlers): daemonClient.IrcAttachment {
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

		expect(broker.requested).toEqual(["Alpha", "Alpha", "Beta"]);
		expect(instanceIdentity().name).toBe("Beta");
		await handle?.close();
	});
});
