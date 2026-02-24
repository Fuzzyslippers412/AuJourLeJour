const crypto = require("crypto");

const QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";
const QWEN_OAUTH_DEVICE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device`;
const QWEN_OAUTH_DEVICE_CODE_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/device/code`;
const QWEN_OAUTH_TOKEN_ENDPOINT = `${QWEN_OAUTH_BASE_URL}/api/v1/oauth2/token`;
const QWEN_OAUTH_CLIENT_ID =
  process.env.QWEN_CLIENT_ID ||
  process.env.QWEN_OAUTH_CLIENT_ID ||
  "f0304373b74a44d2b584a3fb70ca9e56";
const QWEN_OAUTH_SCOPE = "openid profile email model.completion";
const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const QWEN_OAUTH_AUTHORIZE_URL = `${QWEN_OAUTH_BASE_URL}/authorize`;
const QWEN_OAUTH_CLIENT_SLUG = "qwen-code";
const DEFAULT_QWEN_RESOURCE_URL = "https://portal.qwen.ai/v1";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generateCodeVerifier() {
  return base64url(crypto.randomBytes(64)).slice(0, 96);
}

function generateCodeChallenge(verifier) {
  const digest = crypto.createHash("sha256").update(verifier).digest();
  return base64url(digest);
}

function formEncode(payload) {
  const params = new URLSearchParams();
  Object.entries(payload || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    params.set(key, String(value));
  });
  return params;
}

function ensureV1(url) {
  if (url.endsWith("/v1")) return url;
  if (url.endsWith("/v1/")) return url.slice(0, -1);
  return `${url.replace(/\/+$/, "")}/v1`;
}

function normalizeResourceUrl(rawUrl) {
  let url = String(rawUrl || "").trim();
  if (!url) return DEFAULT_QWEN_RESOURCE_URL;
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  try {
    const parsed = new URL(url);
    const host = (parsed.hostname || "").toLowerCase();

    if (host.endsWith("portal.qwen.ai")) {
      return ensureV1(url);
    }
    if (host.endsWith("chat.qwen.ai")) {
      return DEFAULT_QWEN_RESOURCE_URL;
    }
    if (host.includes("dashscope.aliyuncs.com")) {
      if (!url.includes("compatible-mode")) {
        return `${url.replace(/\/+$/, "")}/compatible-mode/v1`;
      }
      return url;
    }
    if (host.endsWith("qwen.ai")) {
      return DEFAULT_QWEN_RESOURCE_URL;
    }
  } catch (err) {
    return DEFAULT_QWEN_RESOURCE_URL;
  }

  return ensureV1(url);
}

async function requestDeviceAuthorization() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const payloadPkce = {
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  };
  const payloadMinimal = {
    client_id: QWEN_OAUTH_CLIENT_ID,
    scope: QWEN_OAUTH_SCOPE,
  };

  const endpoints = [QWEN_OAUTH_DEVICE_ENDPOINT, QWEN_OAUTH_DEVICE_CODE_ENDPOINT];
  const payloads = [payloadPkce, payloadMinimal];
  let lastError = null;

  for (const endpoint of endpoints) {
    for (const payload of payloads) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: formEncode(payload),
        });
        if (!res.ok) {
          lastError = `${res.status} ${await res.text()}`;
          continue;
        }
        const data = await res.json().catch(() => null);
        if (data && data.device_code) {
          if (data.user_code) {
            const userCode = encodeURIComponent(String(data.user_code));
            data.verification_uri_complete = `${QWEN_OAUTH_AUTHORIZE_URL}?user_code=${userCode}&client=${QWEN_OAUTH_CLIENT_SLUG}`;
          }
          data.code_verifier = codeVerifier;
          data.code_challenge = codeChallenge;
          return data;
        }
      } catch (err) {
        lastError = err.message;
      }
    }
  }

  throw new Error(`Device authorization failed: ${lastError || "no response"}`);
}

async function pollDeviceToken(deviceCode, codeVerifier) {
  const payload = {
    grant_type: QWEN_OAUTH_GRANT_TYPE,
    client_id: QWEN_OAUTH_CLIENT_ID,
    device_code: deviceCode,
    code_verifier: codeVerifier,
  };

  const res = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formEncode(payload),
  });

  if (res.status === 400) {
    const data = await res.json().catch(() => ({}));
    if (data.error === "authorization_pending") return { status: "pending" };
    return { status: "error", error: data.error, error_description: data.error_description };
  }

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    if (data.error === "slow_down") return { status: "pending", slow_down: true };
  }

  if (!res.ok) {
    return { status: "error", error: "http_error", error_description: await res.text() };
  }

  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    return { status: "error", error: "invalid_response", error_description: JSON.stringify(data) };
  }

  return { status: "success", token: data };
}

async function refreshAccessToken(refreshToken) {
  const payload = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: QWEN_OAUTH_CLIENT_ID,
  };

  const res = await fetch(QWEN_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formEncode(payload),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json().catch(() => ({}));
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function buildOAuthSettings(tokenData) {
  const expiresIn = Number(tokenData.expires_in || 0);
  const expiryDate = Date.now() + expiresIn * 1000;
  const resourceUrl = normalizeResourceUrl(tokenData.resource_url || DEFAULT_QWEN_RESOURCE_URL);
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    token_type: tokenData.token_type,
    resource_url: resourceUrl,
    expiry_date: expiryDate,
  };
}

function isTokenExpired(oauth, skewMs = 60000) {
  if (!oauth || !oauth.expiry_date) return true;
  return Number(oauth.expiry_date) <= Date.now() + skewMs;
}

module.exports = {
  QWEN_OAUTH_SCOPE,
  requestDeviceAuthorization,
  pollDeviceToken,
  refreshAccessToken,
  buildOAuthSettings,
  normalizeResourceUrl,
  isTokenExpired,
};
