/**
 * Resolve the daemon broker scope for a project directory. Every scope-keying
 * caller (broker client, presence file, `omp ps`) routes through here so
 * `daemon.scope: git-common-dir` collapses every linked worktree of one
 * repository onto its main worktree root while `"cwd"` (the default) keeps
 * today's per-directory scoping.
 *
 * Kept out of `paths.ts`: resolution reads the settings singleton, and
 * `../config/settings` pulls a heavy graph (`@oh-my-pi/pi-ai`, `../discovery`,
 * theme, `AgentStorage`) that `paths.ts` must stay free of for the broker
 * worker and other pure-path consumers.
 */
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { canonicalProjectDir } from "./paths";

/** Canonical dirs identifying one broker scope and the directory that asked for it. */
export interface DaemonScope {
	/** Hash-keyed scope identity: the project dir, or the repository's main worktree root under `daemon.scope: git-common-dir`. */
	scopeDir: string;
	/** Canonical directory the caller asked about; differs from `scopeDir` inside a linked worktree. */
	originDir: string;
}

/** Configured scope mode, or the default when settings are unavailable (SDK/test embedding without `Settings.init()`). */
function scopeMode(): "cwd" | "git-common-dir" {
	try {
		return settings.get("daemon.scope");
	} catch {
		return "cwd";
	}
}

/** Memoized `git-common-dir` resolutions, keyed by `originDir` alone: the `"cwd"` mode never reaches this map (it returns before calling {@link resolveRepoScopeDir}), so there is no mode to disambiguate. */
const scopeDirMemo = new Map<string, string>();

/** Resolve the repository's main worktree root for `originDir`, falling back to `originDir` outside git or on native failure. */
async function resolveRepoScopeDir(originDir: string): Promise<string> {
	const memoized = scopeDirMemo.get(originDir);
	if (memoized !== undefined) return memoized;

	let scopeDir = originDir;
	try {
		const root = vcs.git(originDir)?.primaryRoot();
		if (root !== undefined && root !== null) scopeDir = await canonicalProjectDir(root);
	} catch (error) {
		logger.debug("daemon.scope: git-common-dir resolution failed, falling back to cwd scope", { originDir, error });
	}

	scopeDirMemo.set(originDir, scopeDir);
	return scopeDir;
}

/** Resolve the broker scope for `projectDir` under the configured `daemon.scope` mode. */
export async function resolveDaemonScope(projectDir: string): Promise<DaemonScope> {
	const originDir = await canonicalProjectDir(projectDir);
	if (scopeMode() === "cwd") return { scopeDir: originDir, originDir };
	return { scopeDir: await resolveRepoScopeDir(originDir), originDir };
}

/**
 * Resolve the broker scope for `projectDir` without consulting `daemon.scope`: both
 * `scopeDir` and `originDir` are the plain canonical project dir. For callers whose
 * runtime dir identity is already pinned independent of the setting — global services
 * keyed by their own runtime dir, or `omp ps` re-inspecting a scope it already
 * discovered on disk — so a live settings change or missing `Settings.init()` can't
 * move the identity out from under them.
 */
export async function canonicalDaemonScope(projectDir: string): Promise<DaemonScope> {
	const dir = await canonicalProjectDir(projectDir);
	return { scopeDir: dir, originDir: dir };
}
