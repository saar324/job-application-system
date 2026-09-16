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
  const allowedDomains = (env.WORKER_ALLOWED_DOMAINS ?? DEFAULT_ALLOWED.join(","))
    .split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
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

  function assertNetworkSafe(rawUrl) {
    const url = parse(rawUrl);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".local") || net.isIP(hostname)) {
      throw new Error("local and IP-address application URLs are not allowed");
    }
    return url;
  }

  function assertAllowed(rawUrl, requestDomains = []) {
    const url = assertNetworkSafe(rawUrl);
    const hostname = url.hostname.toLowerCase();
    const scoped = [...allowedDomains, ...requestDomains.map((item) => item.toLowerCase())];
    if (!scoped.some((allowed) => domainMatches(hostname, allowed))) {
      throw new Error(`application domain is not allowed: ${hostname}`);
    }
    return url;
  }

  const resolutions = new Map();
  async function assertPublic(rawUrl) {
    const url = assertNetworkSafe(rawUrl);
    let addresses = resolutions.get(url.hostname);
    if (!addresses) {
      addresses = await lookup(url.hostname, { all: true, verbatim: true });
      resolutions.set(url.hostname, addresses);
    }
    if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) {
      throw new Error(`application hostname does not resolve to a public address: ${url.hostname}`);
    }
    return url;
  }

  return { assertAllowed, assertNetworkSafe, assertPublic, allowedDomains };
}

function privateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
    || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff") || normalized.startsWith("2001:db8:")
    || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.");
}
