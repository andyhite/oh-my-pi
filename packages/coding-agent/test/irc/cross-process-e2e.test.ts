// End-to-end cross-process irc coverage: two independent AgentRegistry/IrcBus
// pairs, each with its own injected instance identity, attached through real
// sockets to one real in-process daemon broker. Exercises the full chain a
// single-process test double cannot: `attachCrossProcessIrc` -> `SocketDaemonClient`
// -> real broker -> the other instance's `SocketDaemonClient` -> `IrcRemoteBridge`.
// ts-no-test-timers exception: broker roster pushes and socket events arrive over a
// real net.Socket that fake timers cannot drive, so `waitFor` polls with a short real sleep.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { createInstanceIdentity } from "@oh-my-pi/pi-coding-agent/irc/instance";
import { attachCrossProcessIrc, type CrossProcessIrcHandle } from "@oh-my-pi/pi-coding-agent/irc/remote";
import { startDaemonBrokerFromEnvironment } from "@oh-my-pi/pi-coding-agent/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
} from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, graceMs = 5000): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(graceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
		await Bun.sleep(10);
	}
}

interface FakeSession {
	session: AgentSession;
	delivered: IrcMessage[];
}

/** Copied from test/tools/hub-cross-process.test.ts: a session that reports a fixed delivery outcome. */
function makeFakeSession(outcome: "injected" | "woken" = "injected"): FakeSession {
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
	return { session: session as unknown as AgentSession, delivered };
}

interface Instance {
	registry: AgentRegistry;
	bus: IrcBus;
	client: DaemonBrokerClient;
	handle: CrossProcessIrcHandle;
}

interface Scope {
	tempDir: TempDir;
	projectDir: string;
	runtimeDir: string;
	broker: Promise<void>;
	clients: DaemonBrokerClient[];
	attachInstance(requestedName: string): Promise<Instance>;
	teardown(): Promise<void>;
}

async function setupScope(): Promise<Scope> {
	const tempDir = TempDir.createSync("@omp-irc-e2e-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);
	const clients: DaemonBrokerClient[] = [];

	async function newClient(): Promise<DaemonBrokerClient> {
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5000 });
		clients.push(client);
		return client;
	}

	// Create the first client (writes broker.token) before starting the broker, which reads it.
	const first = await newClient();
	const broker = startBroker(projectDir, runtimeDir);

	async function attachInstance(requestedName: string): Promise<Instance> {
		const registry = new AgentRegistry();
		const bus = new IrcBus(registry);
		const client = clients.length === 0 ? first : await newClient();
		const handle = await attachCrossProcessIrc({
			cwd: projectDir,
			settings: Settings.isolated({ "irc.crossProcess": true }),
			registry,
			bus,
			client,
			identity: createInstanceIdentity(requestedName),
		});
		if (!handle) throw new Error(`attachCrossProcessIrc returned null for ${requestedName}`);
		return { registry, bus, client, handle };
	}

	async function teardown(): Promise<void> {
		await first.request({ op: "shutdown" }).catch(() => undefined);
		for (const client of clients) client.close();
		await broker;
		await tempDir.remove();
	}

	return { tempDir, projectDir, runtimeDir, broker, clients, attachInstance, teardown };
}

describe("cross-process irc end-to-end", () => {
	let scope: Scope | undefined;

	beforeEach(async () => {
		scope = await setupScope();
	});

	afterEach(async () => {
		await scope?.teardown();
		scope = undefined;
	});

	it("delivers a send from one process's Main agent to another's, across a real broker", async () => {
		if (!scope) throw new Error("scope not initialized");
		const a = await scope.attachInstance("Alpha");
		const b = await scope.attachInstance("Beta");

		const mainA = makeFakeSession();
		a.registry.register({ id: "Main", displayName: "main", kind: "main", session: mainA.session });
		const mainB = makeFakeSession();
		b.registry.register({ id: "Main", displayName: "main", kind: "main", session: mainB.session });

		await waitFor(() => a.registry.getRemotePeer("Beta/Main") !== undefined);

		const receipt = await a.bus.send({ from: "Main", to: "Beta/Main", body: "ping" });

		expect(receipt.outcome).not.toBe("failed");
		expect(mainB.delivered).toHaveLength(1);
		expect(mainB.delivered[0]?.from).toBe("Alpha/Main");
		expect(mainB.delivered[0]?.to).toBe("Main");
	}, 30_000);

	it("delivers from a just-registered local agent without waiting for the roster sync debounce", async () => {
		if (!scope) throw new Error("scope not initialized");
		const a = await scope.attachInstance("Alpha");
		const b = await scope.attachInstance("Beta");

		const mainA = makeFakeSession();
		a.registry.register({ id: "Main", displayName: "main", kind: "main", session: mainA.session });
		const mainB = makeFakeSession();
		b.registry.register({ id: "Main", displayName: "main", kind: "main", session: mainB.session });

		await waitFor(() => a.registry.getRemotePeer("Beta/Main") !== undefined);

		// Register a brand-new local subagent and send from it immediately — no
		// wait for the debounced roster push. Pre-fix this fails with the
		// broker's "does not match a live agent advertised by this connection's
		// instance" rejection because the broker's last accepted roster from A
		// never included "Worker" yet.
		const workerA = makeFakeSession();
		a.registry.register({ id: "Worker", displayName: "task", kind: "sub", session: workerA.session });
		const receipt = await a.bus.send({ from: "Worker", to: "Beta/Main", body: "ping" });

		expect(receipt.outcome).not.toBe("failed");
		expect(mainB.delivered).toHaveLength(1);
		expect(mainB.delivered[0]?.from).toBe("Alpha/Worker");
	}, 30_000);
});
