import { beforeEach, describe, expect, it } from "bun:test";
import { instanceDisplayName, resetInstanceIdentityForTests } from "@oh-my-pi/pi-coding-agent/irc/instance";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

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
		const currentName = instanceDisplayName();

		const result = await executeAcpBuiltinSlashCommand("/peer", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toContain(`Peer name: ${currentName}`);
		expect(outputs[0]).toMatch(/messaging is off/);
		expect(instanceDisplayName()).toBe(currentName);
	});

	it("sets a new name and reports it when no transport is attached", async () => {
		const { runtime, outputs } = makeRuntime();

		const result = await executeAcpBuiltinSlashCommand("/peer Zeta", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toContain("Peer name set to Zeta");
		expect(outputs[0]).toMatch(/messaging is off/);
		expect(instanceDisplayName()).toBe("Zeta");
	});

	it("reports 'enabled but not attached' distinctly from 'off' when the setting is on but the broker isn't attached", async () => {
		const { runtime, outputs } = makeRuntime(true);
		const currentName = instanceDisplayName();

		const result = await executeAcpBuiltinSlashCommand("/peer", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toContain(`Peer name: ${currentName}`);
		expect(outputs[0]).toMatch(/messaging is enabled but not currently attached/);
	});

	it("normalizes a name with disallowed characters and reports the normalization", async () => {
		const { runtime, outputs } = makeRuntime();

		const result = await executeAcpBuiltinSlashCommand("/peer My Peer!", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toContain("Peer name set to MyPeer");
		expect(outputs[0]).toMatch(/normalized from "My Peer!"/);
		expect(instanceDisplayName()).toBe("MyPeer");
	});

	it("rejects an all-punctuation name with the usage string and leaves the name unchanged", async () => {
		const { runtime, outputs } = makeRuntime();
		const currentName = instanceDisplayName();

		const result = await executeAcpBuiltinSlashCommand("/peer ///", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toHaveLength(1);
		expect(outputs[0]).toMatch(/^Usage: \/peer/);
		expect(instanceDisplayName()).toBe(currentName);
	});
});
