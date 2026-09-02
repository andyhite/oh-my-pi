import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { canonicalDaemonScope, resolveDaemonScope } from "../../src/launch/scope";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const tempDirs: string[] = [];

async function runGit(repo: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd: repo, stderr: "pipe", stdout: "pipe", windowsHide: true });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed with exit code ${exitCode ?? 0}`);
	}
	return stdout.trim();
}

/** A `main` checkout plus two linked worktrees, both outside `main` so neither nests inside it. */
async function makeLinkedWorktrees(): Promise<{ main: string; wtA: string; wtB: string }> {
	const main = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scope-main-"));
	tempDirs.push(main);
	await runGit(main, ["init", "-q", "-b", "main"]);
	await runGit(main, ["config", "user.email", "scope@example.com"]);
	await runGit(main, ["config", "user.name", "Scope Test"]);
	await fs.writeFile(path.join(main, "file.txt"), "base\n");
	await runGit(main, ["add", "file.txt"]);
	await runGit(main, ["commit", "-q", "-m", "base"]);

	const wtA = path.join(main, "..", `${path.basename(main)}-a`);
	const wtB = path.join(main, "..", `${path.basename(main)}-b`);
	tempDirs.push(wtA, wtB);
	await runGit(main, ["worktree", "add", "-q", wtA, "-b", "feature/a", "HEAD"]);
	await runGit(main, ["worktree", "add", "-q", wtB, "-b", "feature/b", "HEAD"]);
	return { main, wtA, wtB };
}

let settingsState: SettingsTestState | undefined;

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("resolveDaemonScope", () => {
	it("collapses every linked worktree onto the main worktree root under git-common-dir", async () => {
		settingsState = beginSettingsTest();
		const { main, wtA, wtB } = await makeLinkedWorktrees();
		await Settings.init({ inMemory: true, overrides: { "daemon.scope": "git-common-dir" } });

		const scopeA = await resolveDaemonScope(path.join(wtA, "packages"));
		const scopeB = await resolveDaemonScope(wtB);
		const expectedScopeDir = await fs.realpath(main);

		expect(scopeA.scopeDir).toBe(expectedScopeDir);
		expect(scopeB.scopeDir).toBe(expectedScopeDir);
		expect(scopeA.originDir).not.toBe(scopeB.originDir);
		expect(scopeA.originDir).not.toBe(scopeA.scopeDir);
		expect(getDaemonRuntimeDir(scopeA.scopeDir)).toBe(getDaemonRuntimeDir(scopeB.scopeDir));
	});

	it("keeps every worktree in its own scope under the default cwd mode", async () => {
		settingsState = beginSettingsTest();
		const { wtA, wtB } = await makeLinkedWorktrees();
		await Settings.init({ inMemory: true, overrides: { "daemon.scope": "cwd" } });

		const scopeA = await resolveDaemonScope(wtA);
		const scopeB = await resolveDaemonScope(wtB);

		expect(scopeA.scopeDir).toBe(scopeA.originDir);
		expect(scopeB.scopeDir).toBe(scopeB.originDir);
		expect(getDaemonRuntimeDir(scopeA.scopeDir)).not.toBe(getDaemonRuntimeDir(scopeB.scopeDir));
	});

	it("falls back to the origin dir for a non-git directory under git-common-dir", async () => {
		settingsState = beginSettingsTest();
		const plain = await fs.mkdtemp(path.join(os.tmpdir(), "omp-scope-plain-"));
		tempDirs.push(plain);
		await Settings.init({ inMemory: true, overrides: { "daemon.scope": "git-common-dir" } });

		const scope = await resolveDaemonScope(plain);

		expect(scope.scopeDir).toBe(scope.originDir);
	});
});

describe("canonicalDaemonScope", () => {
	it("returns the worktree dir itself as scopeDir even under daemon.scope: git-common-dir", async () => {
		settingsState = beginSettingsTest();
		const { wtA } = await makeLinkedWorktrees();
		await Settings.init({ inMemory: true, overrides: { "daemon.scope": "git-common-dir" } });

		const scope = await canonicalDaemonScope(wtA);
		const expectedDir = await fs.realpath(wtA);

		expect(scope.scopeDir).toBe(expectedDir);
		expect(scope.originDir).toBe(expectedDir);
	});
});
