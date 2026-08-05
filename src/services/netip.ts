import { isIP } from "node:net";
import type { Request } from "express";
import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Where did this request actually come from?
//
// clientIp() is the answer for EVERYTHING that needs to name a client: rate
// limiter keys, log lines, and the address a human is shown when asked to trust
// a device. It is the transport peer, unless that peer is a configured trusted
// proxy — in which case what the proxy says the client is.
//
// The deployment is what makes this the right (and the only workable) answer:
// cloudflared runs ON THIS HOST and reaches the origin over 127.0.0.1, while
// the container also publishes the port straight onto the LAN
// (network_mode: host). So there are two kinds of request and one function has
// to be correct for both:
//
//   internet visitor -> Cloudflare edge -> cloudflared (127.0.0.1) -> here
//        peer is 127.0.0.1 for EVERY such request, so the peer identifies
//        nobody: keying limiters on it collapses the whole internet into one
//        bucket, and showing it to an approver says "127.0.0.1" for a living
//        room TV and for an attacker abroad alike. CF-Connecting-IP is set by
//        Cloudflare's edge and cannot be set by the visitor, so with a
//        loopback peer it is the true client.
//
//   LAN client -> here (no proxy at all)
//        peer is the real device; its headers are unverifiable client input
//        and are ignored, because a LAN address is not a trusted proxy.
//
// Trusting only loopback by default is what makes both halves true at once.
// Trusting private ranges (an earlier default) handed every LAN machine the
// ability to forge CF-Connecting-IP, i.e. to rotate away from any per-IP
// limit; and `trust proxy: true` is worse still — Express then takes the
// LEFTMOST X-Forwarded-For entry, which is simply whatever the client typed.
// ---------------------------------------------------------------------------

/** Strip IPv4-mapped IPv6 (`::ffff:10.0.1.9`), zone ids and brackets. */
export function normalizeIp(addr: string | undefined | null): string {
  let s = String(addr ?? "").trim().toLowerCase();
  if (!s) return "";
  if (s.startsWith("[")) s = s.slice(1, s.indexOf("]") > 0 ? s.indexOf("]") : undefined);
  const zone = s.indexOf("%");
  if (zone > 0) s = s.slice(0, zone);
  if (s.startsWith("::ffff:") && isIP(s.slice(7)) === 4) s = s.slice(7);
  return s;
}

// --- address classes --------------------------------------------------------
// Deliberately string/arithmetic checks rather than a full CIDR engine: the
// sets below are the same ones Express's `trust proxy` presets name, so the
// value this module trusts and the value `req.ip` is derived from agree.
function v4Octets(ip: string): number[] | null {
  if (isIP(ip) !== 4) return null;
  return ip.split(".").map((o) => Number.parseInt(o, 10));
}

function isLoopback(ip: string): boolean {
  const o = v4Octets(ip);
  return o ? o[0] === 127 : ip === "::1";
}

function isLinkLocal(ip: string): boolean {
  const o = v4Octets(ip);
  if (o) return o[0] === 169 && o[1] === 254;
  return /^fe[89ab]/.test(ip); // fe80::/10
}

function isUniqueLocal(ip: string): boolean {
  const o = v4Octets(ip);
  if (o) {
    return (
      o[0] === 10 ||                          // 10/8
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || // 172.16/12
      (o[0] === 192 && o[1] === 168)          // 192.168/16
    );
  }
  return /^f[cd]/.test(ip); // fc00::/7
}

/** An IPv4 CIDR rule (`10.0.1.0/24`) from the configured trust list. */
function inV4Cidr(ip: string, rule: string): boolean {
  const [net, bitsRaw] = rule.split("/");
  const bits = Number.parseInt(bitsRaw ?? "", 10);
  const a = v4Octets(ip);
  const b = v4Octets(net ?? "");
  if (!a || !b || !Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const toInt = (o: number[]) => ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(a) & mask) === (toInt(b) & mask);
}

/**
 * Does `ip` match one entry of the configured `trust proxy` list? The accepted
 * vocabulary is deliberately the same as Express's — the three presets, literal
 * addresses and CIDRs — so a value that works here works there and the address
 * this module trusts is the address `req.ip` was derived from.
 */
function matchesRule(ip: string, rule: string): boolean {
  switch (rule) {
    case "loopback": return isLoopback(ip);
    case "linklocal": return isLinkLocal(ip);
    case "uniquelocal": return isUniqueLocal(ip);
    default:
      if (rule.includes("/")) return inV4Cidr(ip, rule);
      return normalizeIp(rule) === ip;
  }
}

/** Is the immediate peer one of the proxies we agreed to believe? */
export function isTrustedProxy(ip: string): boolean {
  const s = normalizeIp(ip);
  if (!s || isIP(s) === 0) return false;
  return config.trustProxy.some((rule) => matchesRule(s, rule));
}

/**
 * The other end of the socket. Deliberately NOT exported: it is only an input
 * to clientIp() below. On this deployment it is 127.0.0.1 for every request
 * that came through the tunnel, so using it to name a client — as a limiter key
 * or as an address shown to a person — merges every internet visitor into one.
 */
function peerIp(req: Request): string {
  return normalizeIp(req.socket?.remoteAddress) || "unknown";
}

/**
 * The client's address: the socket peer, or — only when that peer is a trusted
 * proxy — the client that proxy attests to. This is the value to key limiters
 * on, to log, and to show an approver, in both directions: a real visitor
 * address for tunnel traffic and the device's own address on the LAN.
 */
export function clientIp(req: Request): string {
  const peer = peerIp(req);
  if (!isTrustedProxy(peer)) return peer; // headers from an untrusted peer are client input
  const cf = normalizeIp(
    typeof req.headers["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"] : "",
  );
  if (cf && isIP(cf) !== 0) return cf; // set by Cloudflare's edge, not by the visitor
  const viaProxy = normalizeIp(req.ip); // proxy-addr, walking X-Forwarded-For right-to-left
  return viaProxy && isIP(viaProxy) !== 0 ? viaProxy : peer;
}
