import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonScopeKey, getDaemonRuntimeDir, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";

/** Resolve the private runtime directory shared by omp processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** File in a broker runtime dir recording which project (or global service dir) owns the scope. */
const SCOPE_FILE = "scope.json";

/**
 * Canonicalize a project directory the same way every broker client does, so
 * hash-keyed runtime dirs and Windows pipe names agree across processes.
 * Missing paths resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error)) return resolved;
		throw error;
	}
}

/** Scope identity recorded in a broker runtime dir by the broker at startup. */
export interface DaemonScopeMeta {
	/** Canonical directory whose hash keys this runtime dir. */
	projectDir: string;
	/** Directory of the omp process that started the broker; absent for older brokers, or equal to `projectDir` when the scope is not shared. */
	originDir?: string;
}

/**
 * Record the scope's canonical project directory inside its runtime dir.
 * Written by the broker at startup so out-of-process inspectors (`omp ps`)
 * can map a hash-keyed runtime dir back to its project.
 */
export async function writeDaemonScopeMeta(runtimeDir: string, meta: DaemonScopeMeta): Promise<void> {
	await Bun.write(path.join(runtimeDir, SCOPE_FILE), JSON.stringify(meta));
}

/** Read the scope metadata recorded for a runtime dir; undefined when absent or malformed. */
export async function readDaemonScopeMeta(runtimeDir: string): Promise<DaemonScopeMeta | undefined> {
	try {
		const raw: unknown = await Bun.file(path.join(runtimeDir, SCOPE_FILE)).json();
		if (typeof raw === "object" && raw !== null && "projectDir" in raw && typeof raw.projectDir === "string") {
			const originDir = "originDir" in raw && typeof raw.originDir === "string" ? raw.originDir : undefined;
			return { projectDir: raw.projectDir, originDir };
		}
	} catch {
		// Missing or malformed scope metadata reads as unknown.
	}
	return undefined;
}

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(scopeDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\omp-daemon-${daemonScopeKey(scopeDir)}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
