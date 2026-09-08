import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import {
	daemonBrokerIsListening,
	daemonClientForProject,
	type DaemonBrokerClient,
	type IrcAttachment,
} from "../launch/client";
import type { IrcAgentRecord, IrcDeliveryOutcome, IrcIncomingNotification, IrcPeerRecord } from "../launch/protocol";
import { AgentRegistry, type RemoteAgentPeer } from "../registry/agent-registry";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage, type IrcRemoteTransport } from "./bus";
import { IRC_ID_SEPARATOR, qualifyIrcId } from "./identity";
import { type InstanceIdentityStore, processInstanceIdentity } from "./instance";

/** How long to wait for a cross-process peer to acknowledge a message. */
const IRC_ACK_TIMEOUT_MS = 10_000;

/** Trailing debounce window before a roster change is pushed to the broker. */
const SYNC_DEBOUNCE_MS = 100;
/** Minimum gap between two roster pushes, so a burst of local activity coalesces. */
const SYNC_MIN_INTERVAL_MS = 2_000;
/** Ids logged once for containing the cross-process separator, so repeated syncs don't spam. */
const warnedSeparatorIds = new Set<string>();

/** Handle keeping this process attached to its scope's IRC registry. */
export interface CrossProcessIrcHandle {
	close(): Promise<void>;
}

let attachState: { attached: boolean; error?: string } = { attached: false };

/** Whether this process is attached to its scope's IRC registry, and why not when it is not. */
export function crossProcessIrcStatus(): { attached: boolean; error?: string } {
	return attachState;
}

/** Reset the recorded attach state. Test-only. */
export function resetCrossProcessIrcStateForTests(): void {
	attachState = { attached: false };
}

class IrcRemoteBridge implements IrcRemoteTransport {
	readonly #registry: AgentRegistry;
	readonly #bus: IrcBus;
	readonly #identity: InstanceIdentityStore;
	readonly #attachment: IrcAttachment;
	#syncTimer: NodeJS.Timeout | undefined;
	#lastSyncAt = 0;
	/** Ids the broker has accepted for this connection; a sender missing from it would be rejected. */
	#advertised: ReadonlySet<string> = new Set();

	constructor(
		registry: AgentRegistry,
		bus: IrcBus,
		identity: InstanceIdentityStore,
		attach: (bridge: IrcRemoteBridge) => IrcAttachment,
	) {
		this.#registry = registry;
		this.#bus = bus;
		this.#identity = identity;
		this.#attachment = attach(this);
	}

	get instance(): string | undefined {
		return this.#identity.granted();
	}

	/** Current local roster; also fed to the broker on every `irc.sync`. */
	static localRosterOf(registry: AgentRegistry): IrcAgentRecord[] {
		return registry
			.list()
			.filter(ref => {
				if (ref.id.includes(IRC_ID_SEPARATOR)) {
					if (!warnedSeparatorIds.has(ref.id)) {
						warnedSeparatorIds.add(ref.id);
						logger.warn(
							"Local agent id contains the cross-process separator; excluded from the advertised roster",
							{
								id: ref.id,
							},
						);
					}
					return false;
				}
				return ref.kind !== "advisor" && (ref.status === "running" || ref.status === "idle");
			})
			.map(ref => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind === "main" ? "main" : "sub",
				parentId: ref.parentId,
				status: ref.status as "running" | "idle",
				live: registry.isRunning(ref),
				lastActivity: ref.lastActivity,
				activity: ref.activity,
			}));
	}

	/** Replace the registry's cross-process peer overlay with a fresh scope roster. */
	applyRoster(peers: IrcPeerRecord[]): void {
		const mapped: RemoteAgentPeer[] = peers.map(peer => ({
			id: qualifyIrcId(peer.instance, peer.id),
			instance: peer.instance,
			localId: peer.id,
			displayName: peer.displayName,
			kind: peer.kind,
			parentId: peer.parentId ? qualifyIrcId(peer.instance, peer.parentId) : undefined,
			status: peer.status,
			live: peer.live,
			lastActivity: peer.lastActivity,
			activity: peer.activity,
		}));
		this.#registry.setRemotePeers(mapped);
	}

	async incoming(notification: IrcIncomingNotification): Promise<{ outcome: IrcDeliveryOutcome; error?: string }> {
		const receipt = await this.#bus.deliverIncoming(
			{
				id: notification.message.id,
				from: notification.message.from,
				to: notification.message.to,
				body: notification.message.body,
				ts: notification.message.ts,
				replyTo: notification.message.replyTo,
				wakeRelay: notification.message.wakeRelay,
			},
			{ expectsReply: notification.expectsReply },
		);
		if (receipt.outcome === "woken" || receipt.outcome === "revived") this.syncNow();
		return { outcome: receipt.outcome, error: receipt.error };
	}

	async send(
		message: IrcMessage,
		target: { instance: string; id: string },
		opts?: { expectsReply?: boolean; ackTimeoutMs?: number },
	): Promise<IrcDeliveryReceipt> {
		const instance = this.instance;
		if (instance === undefined) {
			throw new Error("Cross-process transport has no broker-granted peer name");
		}
		// The broker validates `from` against the last accepted roster; a sender
		// registered inside the sync debounce window would be rejected. One extra
		// round-trip only when the id is genuinely not advertised yet; the client
		// collapses concurrent syncs, so a broadcast's legs share one.
		if (!this.#advertised.has(message.from)) await this.syncIdentity();
		const result = await this.#attachment.send(
			{
				id: message.id,
				from: qualifyIrcId(instance, message.from),
				to: qualifyIrcId(target.instance, target.id),
				body: message.body,
				ts: message.ts,
				replyTo: message.replyTo,
				wakeRelay: message.wakeRelay,
			},
			{ expectsReply: opts?.expectsReply === true, timeoutMs: opts?.ackTimeoutMs ?? IRC_ACK_TIMEOUT_MS },
		);
		return { to: qualifyIrcId(target.instance, target.id), outcome: result.outcome, error: result.error };
	}

	/** One `irc.sync` round-trip (the attachment adopts the grant); rejects when the broker is unreachable. */
	async pushIdentity(): Promise<void> {
		await this.#attachment.sync();
	}

	syncIdentity(): Promise<void> {
		return this.pushIdentity().catch(error => logger.debug("Cross-process IRC identity sync failed", { error }));
	}

	/** Record the roster the broker just accepted for this connection. */
	noteSynced(agents: IrcAgentRecord[]): void {
		this.#advertised = new Set(agents.map(agent => agent.id));
	}

	/** Debounced trailing sync: coalesces bursts of local registry churn. */
	scheduleSync(): void {
		clearTimeout(this.#syncTimer);
		const delay = Math.max(SYNC_DEBOUNCE_MS, SYNC_MIN_INTERVAL_MS - (Date.now() - this.#lastSyncAt));
		this.#syncTimer = setTimeout(() => {
			this.#syncTimer = undefined;
			this.#lastSyncAt = Date.now();
			void this.syncIdentity();
		}, delay);
		this.#syncTimer.unref?.();
	}

	/** Immediate, undebounced sync — used after a local rename so it lands without delay. */
	syncNow(): void {
		clearTimeout(this.#syncTimer);
		this.#syncTimer = undefined;
		this.#lastSyncAt = Date.now();
		void this.syncIdentity();
	}

	dispose(): void {
		clearTimeout(this.#syncTimer);
		this.#syncTimer = undefined;
	}
}

/**
 * Attach this process's IrcBus + AgentRegistry to the project scope's daemon
 * broker. Returns null when cross-process messaging is disabled or the broker
 * is unreachable — messaging then behaves exactly as a single process.
 */
export async function attachCrossProcessIrc(options: {
	cwd: string;
	settings: Settings;
	registry?: AgentRegistry;
	bus?: IrcBus;
	/** Whether attaching may spawn a broker when none is listening. Defaults to `true`. */
	spawnBroker?: boolean;
	/** Identity to attach under. Defaults to the process-wide identity (`--name`/`/peer`). */
	identity?: InstanceIdentityStore;
	/** Daemon client to attach through. Defaults to the process-shared client for `cwd`. */
	client?: DaemonBrokerClient;
}): Promise<CrossProcessIrcHandle | null> {
	if (options.settings.get("irc.crossProcess") === false) {
		attachState = { attached: false };
		return null;
	}
	const identity = options.identity ?? processInstanceIdentity;
	// A secondary attachment (tests, embedding) never clobbers what `/peer`
	// reports for the process-wide identity.
	const isProcessAttachment = options.identity === undefined && options.client === undefined;
	const setState = (state: { attached: boolean; error?: string }): void => {
		if (isProcessAttachment) attachState = state;
	};
	if (options.spawnBroker === false && options.client === undefined && !(await daemonBrokerIsListening(options.cwd))) {
		setState({ attached: false });
		return null;
	}

	const registry = options.registry ?? AgentRegistry.global();
	const bus = options.bus ?? IrcBus.global();

	let attachment: IrcAttachment | undefined;
	try {
		const client = options.client ?? (await daemonClientForProject(options.cwd));
		const bridge = new IrcRemoteBridge(registry, bus, identity, self => {
			attachment = client.attachIrc(
				{
					token: identity.token(),
					requestedName: () => identity.requested(),
					roster: () => IrcRemoteBridge.localRosterOf(registry),
					synced: ({ requested, granted, agents }) => {
						identity.adoptGranted(requested, granted);
						self.noteSynced(agents);
					},
					incoming: notification => self.incoming(notification),
					rosterChanged: peers => self.applyRoster(peers),
				},
				{ reconnect: options.spawnBroker !== false },
			);
			return attachment;
		});
		await bridge.pushIdentity();
		bus.attachRemote(bridge);
		setState({ attached: true });
		const unsubscribeChange = registry.onChange(() => bridge.scheduleSync());

		const close = async (): Promise<void> => {
			unsubscribeChange();
			bridge.dispose();
			bus.detachRemote(bridge);
			registry.setRemotePeers([]);
			setState({ attached: false });
			await attachment?.detach();
		};
		const cancelCleanup = postmortem.register("cross-process-irc", () => close());
		return {
			close: async () => {
				cancelCleanup();
				await close();
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("Cross-process hub messaging unavailable", { error });
		setState({ attached: false, error: message });
		// Leave no half-installed attachment behind: the daemon client is
		// process-shared, so a lingering `#irc` retries `irc.sync` forever and
		// can still populate the overlay with peers the bus cannot reach.
		await attachment?.detach().catch(() => {});
		registry.setRemotePeers([]);
		return null;
	}
}
