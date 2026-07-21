import { BlockList, isIP } from "node:net";

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
	["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
	["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedIpv4.addSubnet(address, prefix, "ipv4");

const loopbackIpv4 = new BlockList();
loopbackIpv4.addSubnet("127.0.0.0", 8, "ipv4");

const globallyReachableIpv4Exceptions = new BlockList();
for (const address of ["192.0.0.9", "192.0.0.10"] as const) globallyReachableIpv4Exceptions.addAddress(address, "ipv4");

// IPv6 global unicast is currently allocated from 2000::/3. Keep the IANA
// non-global special-purpose ranges inside it denied, with the registry's
// globally reachable more-specific allocations allowed first.
const ipv6GlobalUnicast = new BlockList();
ipv6GlobalUnicast.addSubnet("2000::", 3, "ipv6");

const blockedIpv6GlobalUnicast = new BlockList();
for (const [address, prefix] of [
	["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blockedIpv6GlobalUnicast.addSubnet(address, prefix, "ipv6");

const globallyReachableIpv6Exceptions = new BlockList();
for (const [address, prefix] of [
	["2001:1::1", 128], ["2001:1::2", 128], ["2001:1::3", 128],
	["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28],
] as const) globallyReachableIpv6Exceptions.addSubnet(address, prefix, "ipv6");

/** Return whether an address is globally reachable according to the IANA special-purpose registries. */
export function isGloballyReachableIp(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		if (globallyReachableIpv4Exceptions.check(address, "ipv4")) return true;
		return !blockedIpv4.check(address, "ipv4");
	}
	if (family === 6) {
		if (globallyReachableIpv6Exceptions.check(address, "ipv6")) return true;
		return ipv6GlobalUnicast.check(address, "ipv6") && !blockedIpv6GlobalUnicast.check(address, "ipv6");
	}
	return false;
}

/** Return whether an address is an unambiguous local loopback destination. */
export function isLoopbackIp(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return loopbackIpv4.check(address, "ipv4");
	return family === 6 && address.toLowerCase() === "::1";
}
