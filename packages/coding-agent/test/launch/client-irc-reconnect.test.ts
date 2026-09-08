// Real broker socket + in-process `SocketDaemonClient` instances exercising the client's own
// disconnect/reconnect roster handling and its `#syncIrc` trailing-sync coalescing.
// ts-no-test-timers exception: socket close/reconnect arrive over a real net.Socket that fake
// timers cannot drive, so `waitFor` polls with a short real sleep.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	type DaemonBrokerClient,
	createDaemonBrokerClient,
	daemonBrokerIsListening,
	type IrcAttachHandlers,
	type IrcAttachment,
} from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type IrcAgentRecord,
	type IrcPeerRecord,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

function agentRecord(id: string): IrcAgentRecord {
	return { id, displayName: id, kind: "main", status: "running", live: true, lastActivity: Date.now() };
}

interface Peer {
	name: string;
	agents: IrcAgentRecord[];
	granted: string;
	roster: IrcPeerRecord[];
	attach: IrcAttachment;
}

function makePeer(client: DaemonBrokerClient, name: string, agents: IrcAgentRecord[]): Peer {
	const peer = { name, agents, granted: name, roster: [] as IrcPeerRecord[] } as Peer;
	const handlers: IrcAttachHandlers = {
		token: crypto.randomUUID(),
		requestedName: () => peer.name,
		roster: () => peer.agents,
		nameGranted: (_requested, granted) => {
			peer.granted = granted;
		},
		incoming: async () => ({ outcome: "woken" }),
		rosterChanged: peers => {
			peer.roster = peers;
		},
	};
	peer.attach = client.attachIrc(handlers);
	return peer;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
		await Bun.sleep(10);
	}
}

async function setupScope() {
	const tempDir = TempDir.createSync("@omp-launch-irc-reconnect-");
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
	let broker = startBroker(projectDir, runtimeDir);
	// The in-process broker's listener binds asynchronously; wait for it so a
	// client's first connect attempt never races ahead and spawns a stray
	// duplicate broker on this scope's endpoint.
	const readyDeadline = Date.now() + 5_000;
	while (!(await daemonBrokerIsListening(projectDir, runtimeDir))) {
		if (Date.now() > readyDeadline) break;
		await Bun.sleep(10);
	}

	async function restartBroker(): Promise<void> {
		await broker;
		broker = startBroker(projectDir, runtimeDir);
	}

	async function teardown(): Promise<void> {
		for (const client of clients) client.close();
		await broker.catch(() => undefined);
		await tempDir.remove();
	}

	return {
		projectDir,
		runtimeDir,
		clients,
		newClient,
		restartBroker,
		teardown,
		get first() {
			return first;
		},
	};
}

describe("daemon client irc reconnect handling", () => {
	it("clears the overlay immediately on its own socket close, then repopulates it after reconnect", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();
			await waitFor(() => a.roster.some(row => row.instance === "Beta"));

			// Shutting down the broker closes every connected socket, including this client's own.
			await scope.clients[0].request({ op: "shutdown" }).catch(() => undefined);
			await waitFor(() => a.roster.length === 0, 5_000);
			expect(a.roster).toEqual([]);

			// Restart the broker on the same endpoint; the client's own reconnect loop reattaches
			// and re-syncs automatically, restoring the current peer roster.
			await scope.restartBroker();
			await waitFor(() => a.roster.some(row => row.instance === "Beta"), 10_000);
			expect(a.roster.some(row => row.instance === "Beta")).toBe(true);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("guarantees a fresh trailing sync when the requested name changes during an in-flight sync", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const first = a.attach.sync();
			a.name = "Gamma";
			const second = a.attach.sync();

			const [firstResult, secondResult] = await Promise.all([first, second]);
			expect(firstResult.instance).toBe("Alpha");
			expect(secondResult.instance).toBe("Gamma");
			expect(a.granted).toBe("Gamma");
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("collapses concurrent syncs with an unchanged name and roster into one request", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const first = a.attach.sync();
			const second = a.attach.sync();
			const third = a.attach.sync();

			const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
			expect(firstResult.instance).toBe("Alpha");
			expect(secondResult).toEqual(firstResult);
			expect(thirdResult).toEqual(firstResult);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("does not respawn a broker it deliberately did not start when the connection drops (H2)", async () => {
		const scope = await setupScope();
		try {
			const watcherClient = await scope.newClient();
			const watcher = makePeer(watcherClient, "Watcher", [agentRecord("Main")]);
			await watcher.attach.sync();

			let shutdownRequested = false;
			let clearedAfterShutdown = false;
			const handlers: IrcAttachHandlers = {
				token: crypto.randomUUID(),
				requestedName: () => "NoRespawn",
				roster: () => [agentRecord("Main")],
				nameGranted: () => {},
				incoming: async () => ({ outcome: "woken" }),
				rosterChanged: peers => {
					if (peers.length === 0 && shutdownRequested) clearedAfterShutdown = true;
				},
				reconnect: false,
			};
			const attach: IrcAttachment = scope.clients[0].attachIrc(handlers);
			await attach.sync();
			await waitFor(() => watcher.roster.some(row => row.instance === "NoRespawn"));

			// Only needed to give NoRespawn a non-empty roster to observe clearing;
			// its default reconnect must not respawn the broker after shutdown.
			watcherClient.close();

			shutdownRequested = true;
			await scope.clients[0].request({ op: "shutdown" }).catch(() => undefined);
			await waitFor(() => clearedAfterShutdown, 5_000);

			// Socket teardown (which clears the overlay) precedes the listening
			// socket's own close/unlink inside the broker's shutdown sequence, so
			// wait for listening to actually stop before proving it stays stopped.
			const listeningStoppedDeadline = Date.now() + 5_000;
			while (await daemonBrokerIsListening(scope.projectDir, scope.runtimeDir)) {
				if (Date.now() > listeningStoppedDeadline) throw new Error("broker never stopped listening");
				await Bun.sleep(20);
			}

			// A reconnecting attachment would have a broker listening again well
			// within a few retry intervals; this one must not respawn one.
			for (let i = 0; i < 5; i++) {
				await Bun.sleep(100);
				expect(await daemonBrokerIsListening(scope.projectDir, scope.runtimeDir)).toBe(false);
			}
		} finally {
			await scope.teardown();
		}
	}, 30_000);
});
