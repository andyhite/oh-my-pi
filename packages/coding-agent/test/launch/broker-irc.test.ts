// Integration test — real broker socket and two in-process daemon clients simulate two omp
// instances sharing one project scope. Exercises the low-level irc.sync/irc.list/irc.send/irc.ack
// wire protocol directly (via SocketDaemonClient#attachIrc), not IrcBus or AgentRegistry.
// ts-no-test-timers exception: roster-push and socket-close notifications arrive asynchronously
// over a real net.Socket with no promise/event this test can await directly, and the broker's own
// ack-timeout and idle-grace are driven by real Node timers. Fake timers cannot control the OS
// socket read loop, so `waitFor` polls the observed state with a real short sleep instead of
// guessing a fixed delay before asserting.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import {
	type DaemonBrokerClient,
	DaemonBrokerRejectedError,
	createDaemonBrokerClient,
	type IrcAttachHandlers,
	type IrcAttachment,
} from "../../src/launch/client";
import { canonicalProjectDir, daemonBrokerEndpoint } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type IrcAgentRecord,
	type IrcDeliveryOutcome,
	type IrcIncomingNotification,
	type IrcPeerRecord,
	type IrcWireMessage,
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

function agentRecord(id: string, kind: "main" | "sub" = "main"): IrcAgentRecord {
	return { id, displayName: id, kind, status: "running", live: true, lastActivity: Date.now() };
}

/** A simulated omp instance: one socket client plus its IRC attachment state. */
interface Peer {
	client: DaemonBrokerClient;
	token: string;
	name: string;
	agents: IrcAgentRecord[];
	granted: string;
	roster: IrcPeerRecord[];
	received: IrcIncomingNotification[];
	ackOutcome: IrcDeliveryOutcome;
	/** When true, `incoming` never resolves, so no `irc.ack` is ever sent — simulates a hung peer. */
	stallAck: boolean;
	attach: IrcAttachment;
}

function makePeer(client: DaemonBrokerClient, name: string, agents: IrcAgentRecord[]): Peer {
	const peer = {
		client,
		token: crypto.randomUUID(),
		name,
		agents,
		granted: name,
		roster: [] as IrcPeerRecord[],
		received: [] as IrcIncomingNotification[],
		ackOutcome: "woken" as IrcDeliveryOutcome,
		stallAck: false,
	} as Peer;
	const handlers: IrcAttachHandlers = {
		token: peer.token,
		requestedName: () => peer.name,
		roster: () => peer.agents,
		nameGranted: name => {
			peer.granted = name;
		},
		incoming: async notification => {
			peer.received.push(notification);
			if (peer.stallAck) return new Promise<never>(() => {});
			return { outcome: peer.ackOutcome };
		},
		rosterChanged: peers => {
			peer.roster = peers;
		},
	};
	peer.attach = client.attachIrc(handlers);
	return peer;
}

function message(from: string, to: string, body = "hello"): IrcWireMessage {
	return { id: crypto.randomUUID(), from, to, body, ts: Date.now() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
		await Bun.sleep(10);
	}
}

interface Scope {
	tempDir: TempDir;
	projectDir: string;
	runtimeDir: string;
	broker: Promise<void>;
	clients: DaemonBrokerClient[];
	newClient(): Promise<DaemonBrokerClient>;
	teardown(): Promise<void>;
}

async function setupScope(): Promise<Scope> {
	const tempDir = TempDir.createSync("@omp-launch-irc-");
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

	async function teardown(): Promise<void> {
		await first.request({ op: "shutdown" }).catch(() => undefined);
		for (const client of clients) client.close();
		await broker;
		await tempDir.remove();
	}

	return { tempDir, projectDir, runtimeDir, broker, clients, newClient, teardown };
}

/**
 * Send one request directly on a fresh raw socket, bypassing `SocketDaemonClient`'s id-correlated
 * `request()`. Needed for operations the broker rejects while still parsing the wire request (e.g.
 * an invalid `irc.sync` name): the broker's response in that case always carries `id: "unknown"`
 * because the request's `id` field is never extracted before the parse throws, so a correlated
 * client would wait for a response that can never match and hang until its own timeout.
 */
async function rawWireRequest(
	scope: Scope,
	operation: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
	const token = (await fs.readFile(path.join(scope.runtimeDir, "broker.token"), "utf8")).trim();
	const canonical = await canonicalProjectDir(scope.projectDir);
	const endpoint = daemonBrokerEndpoint(canonical, scope.runtimeDir);
	const socket = net.createConnection({ path: endpoint });
	try {
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", () => resolve());
			socket.once("error", reject);
		});
		const response = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
			let buffer = "";
			socket.setEncoding("utf8");
			socket.on("data", chunk => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					resolve(JSON.parse(buffer.slice(0, newline)));
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			socket.on("error", reject);
			socket.write(`${JSON.stringify({ id: crypto.randomUUID(), token, completionEvents: false, operation })}\n`);
		});
		return response;
	} finally {
		socket.destroy();
	}
}

describe("daemon broker cross-process irc protocol", () => {
	it("advertises each instance's roster to the other, excluding its own rows", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main"), agentRecord("Worker", "sub")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();

			const bList = await b.attach.list();
			expect(bList).toHaveLength(2);
			expect(bList.every(row => row.instance === "Alpha")).toBe(true);
			expect(bList.map(row => row.id).sort()).toEqual(["Main", "Worker"]);
			expect(bList.some(row => row.instance === "Beta")).toBe(false);

			const aList = await a.attach.list();
			expect(aList).toHaveLength(1);
			expect(aList[0]).toMatchObject({ id: "Main", instance: "Beta" });
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("round-trips a send: sender gets the receipt, recipient observes the qualified message", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();
			b.ackOutcome = "woken";

			const result = await a.attach.send(message("Alpha/Main", "Beta/Main", "ping"), {
				expectsReply: true,
				timeoutMs: 5_000,
			});
			expect(result).toEqual({ outcome: "woken", error: undefined });

			expect(b.received).toHaveLength(1);
			expect(b.received[0].expectsReply).toBe(true);
			expect(b.received[0].message.from).toBe("Alpha/Main");
			expect(b.received[0].message.to).toBe("Beta/Main");
			expect(b.received[0].message.body).toBe("ping");
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("suffixes a colliding requested name and both variants remain independently addressable", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Alpha", [agentRecord("Main")]);
			await a.attach.sync();
			const bSync = await b.attach.sync();
			expect(bSync.instance).toBe("Alpha-2");
			expect(b.granted).toBe("Alpha-2");

			await waitFor(() => a.roster.some(row => row.instance === "Alpha-2"));
			expect(a.roster.some(row => row.instance === "Alpha-2")).toBe(true);

			const toB = await a.attach.send(message("Alpha/Main", "Alpha-2/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toB.outcome).toBe("woken");
			expect(b.received).toHaveLength(1);

			const toA = await b.attach.send(message("Alpha-2/Main", "Alpha/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toA.outcome).toBe("woken");
			expect(a.received).toHaveLength(1);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("propagates a rename to the peer's roster and makes the old name unreachable", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();

			a.name = "Gamma";
			const renameResult = await a.attach.sync();
			expect(renameResult.instance).toBe("Gamma");
			expect(a.granted).toBe("Gamma");

			await waitFor(() => b.roster.some(row => row.instance === "Gamma"));
			expect(b.roster.some(row => row.instance === "Alpha")).toBe(false);

			const toGamma = await b.attach.send(message("Beta/Main", "Gamma/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toGamma.outcome).toBe("woken");

			const toOldName = await b.attach.send(message("Beta/Main", "Alpha/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toOldName.outcome).toBe("failed");
			expect(toOldName.error).toContain("no longer reachable");
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("reclaims its own current name on re-sync without drifting to a suffix", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Delta", [agentRecord("Main")]);
			const first = await a.attach.sync();
			expect(first.instance).toBe("Delta");

			// Re-sync the SAME token requesting the SAME name it already holds.
			const second = await a.attach.sync();
			expect(second.instance).toBe("Delta");
			expect(a.granted).toBe("Delta");
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("fails a send to a nonexistent instance and to one whose socket has closed", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();

			const toNobody = await a.attach.send(message("Alpha/Main", "Nobody/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toNobody.outcome).toBe("failed");
			expect(toNobody.error).toContain("no longer reachable");
			expect(toNobody.error).toContain("Nobody");

			b.client.close();
			await waitFor(() => a.roster.every(row => row.instance !== "Beta"));

			const toClosed = await a.attach.send(message("Alpha/Main", "Beta/Main"), {
				expectsReply: false,
				timeoutMs: 5_000,
			});
			expect(toClosed.outcome).toBe("failed");
			expect(toClosed.error).toContain("no longer reachable");
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("resolves failed on ack timeout instead of hanging", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();
			b.stallAck = true;

			const started = Date.now();
			const result = await a.attach.send(message("Alpha/Main", "Beta/Main"), {
				expectsReply: false,
				timeoutMs: 200,
			});
			expect(Date.now() - started).toBeLessThan(5_000);
			expect(result.outcome).toBe("failed");
			expect(result.error).toContain("did not acknowledge delivery");
			expect(b.received).toHaveLength(1);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("pushes an updated roster to the remaining peer when a socket disconnects", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();
			await waitFor(() => a.roster.some(row => row.instance === "Beta"));

			b.client.close();
			await waitFor(() => a.roster.every(row => row.instance !== "Beta"));
			expect(a.roster.some(row => row.instance === "Beta")).toBe(false);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("rejects an irc.send whose token is not bound to the sending socket", async () => {
		const scope = await setupScope();
		try {
			const a = makePeer(scope.clients[0], "Alpha", [agentRecord("Main")]);
			const b = makePeer(await scope.newClient(), "Beta", [agentRecord("Main")]);
			await a.attach.sync();
			await b.attach.sync();

			const foreignToken = crypto.randomUUID();
			let caught: unknown;
			try {
				await a.client.request({
					op: "irc.send",
					token: foreignToken,
					message: message("Alpha/Main", "Beta/Main"),
					expectsReply: false,
					timeoutMs: 5_000,
				});
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(DaemonBrokerRejectedError);
		} finally {
			await scope.teardown();
		}
	}, 30_000);

	it("rejects an irc.sync whose requested name fails validation", async () => {
		const scope = await setupScope();
		try {
			// Bring the broker's listening socket up via the normal retrying client before dialing
			// it directly — `rawWireRequest` connects once with no retry.
			await scope.clients[0].request({ op: "ping" });
			const response = await rawWireRequest(scope, {
				op: "irc.sync",
				token: crypto.randomUUID(),
				name: "bad name/x",
				agents: [agentRecord("Main")],
			});
			expect(response.ok).toBe(false);
			expect(response.error).toBeTruthy();
		} finally {
			await scope.teardown();
		}
	}, 30_000);
});
