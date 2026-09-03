import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	adoptGrantedInstanceName,
	initInstanceName,
	instanceIdentity,
	onInstanceNameChanged,
	resetInstanceIdentityForTests,
	sanitizeInstanceName,
	setInstanceName,
} from "@oh-my-pi/pi-coding-agent/irc/instance";

describe("instance identity", () => {
	beforeEach(() => {
		resetInstanceIdentityForTests();
	});

	afterEach(() => {
		resetInstanceIdentityForTests();
	});

	it("sanitizes a requested --name at init", () => {
		const name = initInstanceName("My Peer!");
		expect(name).toBe("MyPeer");
		expect(instanceIdentity().name).toBe("MyPeer");
	});

	it("generates a valid default name when none is requested", () => {
		const name = initInstanceName();
		expect(name.length).toBeGreaterThan(0);
		expect(name).toMatch(/^[A-Za-z0-9_-]{1,48}$/);
	});

	it("keeps the token stable across name changes", () => {
		initInstanceName("Alpha");
		const tokenAfterInit = instanceIdentity().token;

		setInstanceName("Beta");

		expect(instanceIdentity().token).toBe(tokenAfterInit);
		expect(instanceIdentity().name).toBe("Beta");
	});

	it("notifies listeners exactly once per real name change", () => {
		initInstanceName("Alpha");
		const seen: string[] = [];
		onInstanceNameChanged(name => seen.push(name));

		setInstanceName("Beta");

		expect(seen).toEqual(["Beta"]);
	});

	it("does not notify listeners when the sanitized name is unchanged", () => {
		initInstanceName("Alpha");
		const seen: string[] = [];
		onInstanceNameChanged(name => seen.push(name));

		setInstanceName("Alpha");

		expect(seen).toEqual([]);
	});

	it("adopts a granted name without notifying listeners", () => {
		initInstanceName("Alpha");
		const seen: string[] = [];
		onInstanceNameChanged(name => seen.push(name));

		adoptGrantedInstanceName("Alpha-2");

		expect(seen).toEqual([]);
		expect(instanceIdentity().name).toBe("Alpha-2");
	});

	it("sanitizes a name with no surviving characters to undefined", () => {
		expect(sanitizeInstanceName("///")).toBeUndefined();
	});

	it("ignores a differing --name on a second initInstanceName call", () => {
		initInstanceName("Alpha");
		const original = instanceIdentity();

		initInstanceName("Gamma");

		expect(instanceIdentity().name).toBe(original.name);
		expect(instanceIdentity().token).toBe(original.token);
	});

	it("throws when setInstanceName sanitizes to no surviving characters", () => {
		initInstanceName("Alpha");
		expect(() => setInstanceName("///")).toThrow();
	});
});
