import { beforeEach, describe, expect, it } from "bun:test";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { instanceIdentity, resetInstanceIdentityForTests } from "@oh-my-pi/pi-coding-agent/irc/instance";

function makeRuntime(crossProcessEnabled = false) {
	const outputs: string[] = [];
	const runtime = {
		output: async (text: string) => {
			outputs.push(text);
		},
		settings: {
			get: (key: string) => (key === "irc.crossProcess" ? crossProcessEnabled : undefined),
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, outputs };
}

describe("/peer slash command", () => {
	beforeEach(() => {
		resetInstanceIdentityForTests();
	});

	it("reports the current generated name when called bare with no transport attached", async () => {
		const { runtime, outputs } = makeRuntime();
		const currentName = instanceIdentity().name;

		const result = await executeAcpBuiltinSlashCommand("/peer", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toEqual([
			`Peer name: ${currentName} (cross-process messaging is off; only local agent ids are addressable).`,
		]);
		expect(instanceIdentity().name).toBe(currentName);
	});

	it("sets a new name and reports it when no transport is attached", async () => {
		const { runtime, outputs } = makeRuntime();

		const result = await executeAcpBuiltinSlashCommand("/peer Zeta", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toEqual(["Peer name set to Zeta (cross-process messaging is off; it applies if it turns on)."]);
		expect(instanceIdentity().name).toBe("Zeta");
	});

	it("reports 'enabled but not attached' distinctly from 'off' when the setting is on but the broker isn't attached", async () => {
		const { runtime, outputs } = makeRuntime(true);
		const currentName = instanceIdentity().name;

		const result = await executeAcpBuiltinSlashCommand("/peer", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toEqual([
			`Peer name: ${currentName} (cross-process messaging is enabled but not currently attached to the project broker; only local agent ids are addressable).`,
		]);
	});

	it("rejects an all-punctuation name with the usage string and leaves the name unchanged", async () => {
		const { runtime, outputs } = makeRuntime();
		const currentName = instanceIdentity().name;

		const result = await executeAcpBuiltinSlashCommand("/peer ///", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toEqual(["Usage: /peer <name> (letters, numbers, underscores, hyphens)"]);
		expect(instanceIdentity().name).toBe(currentName);
	});
});
