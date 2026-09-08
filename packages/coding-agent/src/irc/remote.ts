import { logger, postmortem } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { daemonClientForProject, type IrcAttachment } from "../launch/client";
import type { IrcAgentRecord, IrcDeliveryOutcome, IrcIncomingNotification, IrcPeerRecord } from "../launch/protocol";
import { AgentRegistry, type RemoteAgentPeer } from "../registry/agent-registry";
import { IrcBus, type IrcDeliveryReceipt, type IrcMessage, type IrcRemoteTransport } from "./bus";
import { IRC_ID_SEPARATOR, qualifyIrcId } from "./identity";
import { adoptGrantedInstanceName, instanceIdentity, onInstanceNameChanged } from "./instance";

/** How long to wait for a cross-process peer to acknowledge a message. */
const IRC_ACK_TIMEOUT_MS = 10_000;

/** Trailing debounce window before a roster change is pushed to the broker. */
const SYNC_DEBOUNCE_MS = 100;
/** Minimum gap between two roster pushes, so a burst of local activity coalesces. */
const SYNC_MIN_INTERVAL_MS = 2_000;

/** Handle keeping this process attached to its scope's IRC registry. */
export interface CrossProcessIrcHandle {
	close(): Promise<void>;
}

class IrcRemoteBridge implements IrcRemoteTransport {
	readonly #registry: AgentRegistry;
	readonly #bus: IrcBus;
	readonly #attachment: IrcAttachment;
	#syncTimer: NodeJS.Timeout | undefined;
	#lastSyncAt = 0;
	#inFlightSync: Promise<void> | undefined;
	#queuedSync: Promise<void> | undefined;

	constructor(registry: AgentRegistry, bus: IrcBus, attach: (bridge: IrcRemoteBridge) => IrcAttachment) {
		this.#registry = registry;
		this.#bus = bus;
		this.#attachment = attach(this);
	}

	get instance(): string {
		return instanceIdentity().name;
	}

	/** Current local roster; also fed to the broker on every `irc.sync`. */
	static localRosterOf(registry: AgentRegistry): IrcAgentRecord[] {
		return registry
			.list()
			.filter(
				ref =>
					ref.kind !== "advisor" &&
					(ref.status === "running" || ref.status === "idle") &&
					!ref.id.includes(IRC_ID_SEPARATOR),
			)
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
			},
			{ expectsReply: notification.expectsReply },
		);
		return { outcome: receipt.outcome, error: receipt.error };
	}

	async send(
		message: IrcMessage,
		target: { instance: string; id: string },
		opts?: { expectsReply?: boolean },
	): Promise<IrcDeliveryReceipt> {
		const result = await this.#attachment.send(
			{
				id: message.id,
				from: qualifyIrcId(this.instance, message.from),
				to: qualifyIrcId(target.instance, target.id),
				body: message.body,
				ts: message.ts,
				replyTo: message.replyTo,
			},
			{ expectsReply: opts?.expectsReply === true, timeoutMs: IRC_ACK_TIMEOUT_MS },
		);
		return { to: qualifyIrcId(target.instance, target.id), outcome: result.outcome, error: result.error };
	}

	async refresh(): Promise<void> {
		try {
			this.applyRoster(await this.#attachment.list());
		} catch (error) {
			logger.debug("Cross-process IRC roster refresh failed", { error });
		}
	}

	/**
	 * Push name + roster and adopt the broker's grant. A call arriving while a
	 * sync is in flight runs a fresh sync after it (never joining the stale
	 * request), so a rename or roster change is never dropped; further calls
	 * while one is queued collapse into that queued run.
	 */
	syncIdentity(): Promise<void> {
		if (this.#queuedSync) return this.#queuedSync;
		if (this.#inFlightSync) {
			const queued = this.#inFlightSync.then(() => {
				this.#queuedSync = undefined;
				return this.syncIdentity();
			});
			this.#queuedSync = queued;
			return queued;
		}
		const run = this.pushIdentity()
			.catch(error => logger.debug("Cross-process IRC identity sync failed", { error }))
			.finally(() => {
				if (this.#inFlightSync === run) this.#inFlightSync = undefined;
			});
		this.#inFlightSync = run;
		return run;
	}

	/** One `irc.sync` round-trip (the attachment adopts the grant); rejects when the broker is unreachable. */
	async pushIdentity(): Promise<void> {
		this.applyRoster((await this.#attachment.sync()).peers);
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
}): Promise<CrossProcessIrcHandle | null> {
	if (options.settings.get("irc.crossProcess") === false) return null;

	const registry = options.registry ?? AgentRegistry.global();
	const bus = options.bus ?? IrcBus.global();

	let attachment: IrcAttachment | undefined;
	try {
		const client = await daemonClientForProject(options.cwd);
		const bridge = new IrcRemoteBridge(registry, bus, self => {
			attachment = client.attachIrc({
				token: instanceIdentity().token,
				requestedName: () => instanceIdentity().name,
				roster: () => IrcRemoteBridge.localRosterOf(registry),
				nameGranted: adoptGrantedInstanceName,
				incoming: notification => self.incoming(notification),
				rosterChanged: peers => self.applyRoster(peers),
			});
			return attachment;
		});
		await bridge.pushIdentity();
		bus.attachRemote(bridge);
		const unsubscribeChange = registry.onChange(() => bridge.scheduleSync());
		const unsubscribeName = onInstanceNameChanged(() => bridge.syncNow());

		const close = async (): Promise<void> => {
			unsubscribeChange();
			unsubscribeName();
			bridge.dispose();
			bus.detachRemote(bridge);
			registry.setRemotePeers([]);
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
		logger.warn("Cross-process hub messaging unavailable", { error });
		// Leave no half-installed attachment behind: the daemon client is
		// process-shared, so a lingering `#irc` retries `irc.sync` forever and
		// can still populate the overlay with peers the bus cannot reach.
		await attachment?.detach().catch(() => {});
		registry.setRemotePeers([]);
		return null;
	}
}
