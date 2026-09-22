import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

const DEFAULT_ALLOWED = [
  "greenhouse.io", "lever.co", "myworkdayjobs.com", "smartrecruiters.com", "ashbyhq.com",
  "recruitee.com", "rippling.com", "teamtailor.com", "bamboohr.com", "workable.com",
  "applytojob.com", "zohorecruit.com",
  "remoteok.com", "jobicy.com", "arbeitnow.com", "himalayas.app",
  "docs.google.com"
];

function domainMatches(hostname, allowed) {
  return hostname === allowed || hostname.endsWith(`.${allowed}`);
}

export function createUrlPolicy(env = process.env, lookup = dnsLookup) {
  const configuredDomains = env.WORKER_ALLOWED_DOMAINS?.trim();
  const allowedDomains = [...new Set([
    ...DEFAULT_ALLOWED,
    ...(configuredDomains ?? "").split(",")
  ].map((item) => item.trim().toLowerCase()).filter(Boolean))];
  const allowHttp = env.WORKER_ALLOW_HTTP === "true";

  function parse(rawUrl) {
    let url;
    try { url = new URL(rawUrl); }
    catch { throw new Error("application URL is invalid"); }
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
      throw new Error("application URL must use HTTPS");
    }
    return url;
  }

  function policyError(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function assertNetworkSafe(rawUrl) {
    const url = parse(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".local") || net.isIP(hostname)) {
      throw policyError("destination_literal_or_local", "local and IP-address application URLs are not allowed");
    }
    return url;
  }

  function assertAllowed(rawUrl, additionalDomains = []) {
    const url = assertNetworkSafe(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const exactAdditional = new Set(additionalDomains.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
    if (!allowedDomains.some((allowed) => domainMatches(hostname, allowed)) && !exactAdditional.has(hostname)) {
      throw policyError("destination_host_not_allowed", `application domain is not allowed: ${hostname}`);
    }
    return url;
  }

  async function assertPublic(rawUrl) {
    const url = assertNetworkSafe(rawUrl);
    await resolvePublicHost(url.hostname);
    return url;
  }

  async function resolvePublicHost(hostname) {
    const normalized = String(hostname).toLowerCase();
    if (normalized === "localhost" || normalized.endsWith(".local") || net.isIP(normalized)) {
      throw policyError("destination_literal_or_local", "local and IP-address destinations are not allowed");
    }
    const addresses = await lookup(normalized, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => classifyAddress(address) !== "public")) {
      throw policyError("destination_address_not_public",
        `application hostname does not resolve exclusively to public addresses: ${normalized}`);
    }
    return addresses;
  }

  return { assertAllowed, assertNetworkSafe, assertPublic, resolvePublicHost, allowedDomains, allowHttp };
}

export function classifyAddress(address) {
  const mapped = mappedIpv4(address);
  if (mapped) return classifyAddress(mapped);
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    const blocked = a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
    return blocked ? "non_public" : "public";
  }
  if (!net.isIPv6(address)) return "invalid";
  const normalized = address.toLowerCase();
  const blocked = normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")
    || normalized.startsWith("2001:10:");
  return blocked ? "non_public" : "public";
}

function mappedIpv4(address) {
  const normalized = String(address).toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted && net.isIPv4(dotted[1])) return dotted[1];
  const hexadecimal = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hexadecimal) return null;
  const high = Number.parseInt(hexadecimal[1], 16);
  const low = Number.parseInt(hexadecimal[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}
