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
});
