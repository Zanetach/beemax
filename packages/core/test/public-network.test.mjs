import assert from "node:assert/strict";
import test from "node:test";
import { isGloballyReachableIp, isLoopbackIp } from "../dist/index.js";

test("public network policy rejects IANA non-global IPv4 and IPv6 address space", () => {
	for (const address of [
		"0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
		"172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1",
		"198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
		"::", "::1", "::ffff:127.0.0.1", "64:ff9b::1", "64:ff9b:1::1", "100::1",
		"2001:2::1", "2001:db8::1", "2002::1", "3fff::1", "5f00::1", "fc00::1",
		"fec0::1", "fe80::1", "ff00::1",
	]) assert.equal(isGloballyReachableIp(address), false, address);
});

test("public network policy retains IANA globally reachable exceptions and public unicast", () => {
	for (const address of [
		"1.1.1.1", "8.8.8.8", "192.0.0.9", "192.0.0.10", "93.184.216.34",
		"2001:1::1", "2001:3::1", "2001:4:112::1", "2001:20::1",
		"2001:30::1", "2001:4860:4860::8888", "2606:4700:4700::1111",
	]) assert.equal(isGloballyReachableIp(address), true, address);
});

test("loopback policy recognizes only explicit IPv4 and IPv6 loopback addresses", () => {
	for (const address of ["127.0.0.1", "127.255.255.254", "::1"]) assert.equal(isLoopbackIp(address), true, address);
	for (const address of ["0.0.0.0", "10.0.0.1", "169.254.169.254", "::", "::ffff:127.0.0.1", "fe80::1", "1.1.1.1"]) {
		assert.equal(isLoopbackIp(address), false, address);
	}
});
