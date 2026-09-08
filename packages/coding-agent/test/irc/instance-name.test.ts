import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	adoptGrantedInstanceName,
	initInstanceName,
	instanceDisplayName,
	instanceIdentity,
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
		expect(instanceDisplayName()).toBe("MyPeer");
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
	});

	it("ignores a grant for a name that was replaced while the request was in flight", () => {
		initInstanceName("Alpha");
		setInstanceName("Beta");

		adoptGrantedInstanceName("Alpha", "Alpha-2");

		expect(instanceDisplayName()).toBe("Beta");
	});

	it("pins a suffixed grant: both requested and granted move to the broker's answer", () => {
		initInstanceName("Alpha");

		adoptGrantedInstanceName("Alpha", "Alpha-2");

		expect(instanceIdentity().granted).toBe("Alpha-2");
		expect(instanceIdentity().requested).toBe("Alpha-2");
	});

	it("leaves the granted name unchanged across a rename until the broker confirms it", () => {
		initInstanceName("Alpha");
		adoptGrantedInstanceName("Alpha", "Alpha");

		setInstanceName("Beta");

		expect(instanceIdentity().granted).toBe("Alpha");
		expect(instanceIdentity().requested).toBe("Beta");

		adoptGrantedInstanceName("Beta", "Beta");

		expect(instanceIdentity().granted).toBe("Beta");
	});

	it("sanitizes a name with no surviving characters to undefined", () => {
		expect(sanitizeInstanceName("///")).toBeUndefined();
	});

	it("applies a requested --name even when the identity was already created lazily, keeping the token", () => {
		const lazy = instanceIdentity();

		const name = initInstanceName("Gamma");

		expect(name).toBe("Gamma");
		expect(instanceDisplayName()).toBe("Gamma");
		expect(instanceIdentity().token).toBe(lazy.token);
	});

	it("throws when setInstanceName sanitizes to no surviving characters", () => {
		initInstanceName("Alpha");
		expect(() => setInstanceName("///")).toThrow();
	});
});
