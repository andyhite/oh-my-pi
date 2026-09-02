import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { registerDaemonProjectPresence } from "../../src/launch/presence";
import { canonicalDaemonScope } from "../../src/launch/scope";

describe("daemon presence canonicalProjectDir EISDIR fallback", () => {
	const originalRealpath = fs.realpath.bind(fs);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the resolved path when realpath throws EISDIR", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eisdir-fallback-"));
		const runtimeDir = path.join(projectDir, "runtime");
		const resolvedProjectDir = path.resolve(projectDir);
		let realpathCalls = 0;

		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === resolvedProjectDir) {
				realpathCalls++;
				const err = new Error("EISDIR: illegal operation on a directory") as NodeJS.ErrnoException;
				err.code = "EISDIR";
				err.errno = -21;
				err.syscall = "lstat";
				err.path = `R:${path.sep}`;
				throw err;
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);

		try {
			const scope = await canonicalDaemonScope(projectDir);
			expect(realpathCalls).toBe(1);
			const presence = await registerDaemonProjectPresence(scope, runtimeDir);
			expect(typeof presence.close).toBe("function");

			const clientsDir = path.join(runtimeDir, "clients");
			const entries = await fs.readdir(clientsDir);
			expect(entries).toHaveLength(1);

			await presence.close();
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
