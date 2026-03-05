const os = require("os");

function parseHostAndPort(hostHeader) {
  const raw = String(hostHeader || "").trim();
  if (!raw) return { hostname: "", port: null };
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end === -1) return { hostname: raw.toLowerCase(), port: null };
    const hostname = raw.slice(1, end).toLowerCase();
    const rest = raw.slice(end + 1);
    if (rest.startsWith(":")) {
      const port = Number(rest.slice(1));
      return { hostname, port: Number.isInteger(port) && port > 0 ? port : null };
    }
    return { hostname, port: null };
  }
  const parts = raw.split(":");
  if (parts.length > 1) {
    const portCandidate = Number(parts[parts.length - 1]);
    if (Number.isInteger(portCandidate) && portCandidate > 0) {
      return {
        hostname: parts.slice(0, -1).join(":").toLowerCase(),
        port: portCandidate,
      };
    }
  }
  return { hostname: raw.toLowerCase(), port: null };
}

function isLocalHostName(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "0.0.0.0" || value === "::1";
}

function classifyLanAddressPriority(address) {
  const value = String(address || "").trim();
  if (!value) return 999;
  if (/^192\.168\./.test(value)) return 1;
  if (/^10\./.test(value)) return 2;
  const m = value.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (Number.isInteger(second) && second >= 16 && second <= 31) return 3;
  }
  if (/^169\.254\./.test(value)) return 998; // link-local, avoid for sharing
  return 10;
}

function getLanIPv4List() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const infos of Object.values(interfaces || {})) {
    for (const info of infos || []) {
      if (info && info.family === "IPv4" && !info.internal && info.address) {
        addresses.push(info.address);
      }
    }
  }
  const deduped = Array.from(new Set(addresses));
  deduped.sort((a, b) => {
    const pa = classifyLanAddressPriority(a);
    const pb = classifyLanAddressPriority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  return deduped.filter((addr) => classifyLanAddressPriority(addr) < 900);
}

function getFirstLanIPv4() {
  const list = getLanIPv4List();
  return list[0] || null;
}

function createShareRuntime({ shareViewerBaseUrl, publicBaseUrl, port }) {
  function getViewerBaseUrl(req) {
    if (shareViewerBaseUrl) return shareViewerBaseUrl;
    if (publicBaseUrl) return publicBaseUrl;

    const hostHeader = String(req.get("host") || "").trim();
    const forwardedProtoRaw = String(req.get("x-forwarded-proto") || "").trim();
    const protocol = forwardedProtoRaw ? forwardedProtoRaw.split(",")[0].trim() : req.protocol;

    if (hostHeader) {
      const parsed = parseHostAndPort(hostHeader);
      if (isLocalHostName(parsed.hostname)) {
        const lan = getFirstLanIPv4();
        if (lan) {
          const resolvedPort = parsed.port || port;
          return `${protocol || "http"}://${lan}:${resolvedPort}`;
        }
      }
      return `${protocol || "http"}://${hostHeader}`;
    }

    const lan = getFirstLanIPv4();
    if (lan) return `http://${lan}:${port}`;
    return `http://localhost:${port}`;
  }

  function buildViewerShareUrl(req, token) {
    const cleanToken = String(token || "").trim();
    if (!cleanToken) return "";
    const base = getViewerBaseUrl(req);
    return `${String(base).replace(/\/+$/, "")}/?share=${encodeURIComponent(cleanToken)}`;
  }

  return {
    parseHostAndPort,
    isLocalHostName,
    getLanIPv4List,
    getFirstLanIPv4,
    getViewerBaseUrl,
    buildViewerShareUrl,
  };
}

module.exports = {
  createShareRuntime,
};
