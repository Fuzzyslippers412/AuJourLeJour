const { randomBytes } = require("crypto");

const MAX_HOUSEHOLD_ITEMS = 3000;
const MAX_HOUSEHOLD_PAYLOAD_BYTES = 2_000_000;
const MAX_HOUSEHOLD_EVENTS = 5000;

function generateHouseholdId() {
  return randomBytes(18).toString("base64url");
}

function generateHouseholdOwnerKey() {
  return randomBytes(32).toString("base64url");
}

function generateHouseholdMemberToken() {
  return randomBytes(24).toString("base64url");
}

function generateHouseholdInviteToken() {
  return randomBytes(18).toString("base64url");
}

function isValidHouseholdId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{18,128}$/.test(value);
}

function isValidHouseholdOwnerKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{24,256}$/.test(value);
}

function isValidHouseholdMemberToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{24,256}$/.test(value);
}

function isValidHouseholdInviteToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{18,128}$/.test(value);
}

function sanitizeHouseholdName(value) {
  const clean = String(value || "").trim();
  return clean ? clean.slice(0, 120) : "";
}

function sanitizeMemberName(value) {
  const clean = String(value || "").trim();
  return clean ? clean.slice(0, 80) : "";
}

function sanitizeNote(value) {
  const clean = String(value || "").trim();
  return clean ? clean.slice(0, 240) : "";
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch (err) {
    return null;
  }
}

function safeJsonParse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

function parseInviteToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return String(
        parsed.searchParams.get("household_invite") ||
          parsed.searchParams.get("invite") ||
          parsed.pathname.split("/").filter(Boolean).pop() ||
          ""
      ).trim();
    } catch (err) {
      return "";
    }
  }
  return raw;
}

function parseInviteExpiresAt(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "Invalid invite expiry." };
  }
  if (parsed.getTime() <= Date.now()) {
    return { ok: false, error: "Invite expiry must be in the future." };
  }
  return { ok: true, value: parsed.toISOString() };
}

function buildHouseholdRecoveryCode(householdId, ownerKey) {
  const id = String(householdId || "").trim();
  const key = String(ownerKey || "").trim();
  if (!isValidHouseholdId(id) || !isValidHouseholdOwnerKey(key)) return "";
  return `ajl-owner:${id}:${key}`;
}

function parseHouseholdRecoveryCode(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return { household_id: "", owner_key: "" };
  }
  const compact = raw.replace(/\s+/g, "");
  if (/^ajl-owner:/i.test(compact)) {
    const parts = compact.split(":");
    return {
      household_id: String(parts[1] || "").trim(),
      owner_key: String(parts.slice(2).join(":") || "").trim(),
    };
  }
  if (compact.includes(".")) {
    const [householdId, ownerKey] = compact.split(".", 2);
    return {
      household_id: String(householdId || "").trim(),
      owner_key: String(ownerKey || "").trim(),
    };
  }
  if (compact.includes(":")) {
    const [householdId, ownerKey] = compact.split(":", 2);
    return {
      household_id: String(householdId || "").trim(),
      owner_key: String(ownerKey || "").trim(),
    };
  }
  return { household_id: "", owner_key: "" };
}

function validateHouseholdPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "Invalid household payload." };
  }
  if (!Array.isArray(payload.items)) {
    return { ok: false, error: "Household payload items are required." };
  }
  if (payload.items.length > MAX_HOUSEHOLD_ITEMS) {
    return { ok: false, error: `Too many household items (max ${MAX_HOUSEHOLD_ITEMS}).` };
  }
  if (payload.period && !/^\d{4}-\d{2}$/.test(String(payload.period))) {
    return { ok: false, error: "Invalid household period." };
  }
  for (const item of payload.items) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Invalid household item." };
    }
    if (!item.id || typeof item.id !== "string") {
      return { ok: false, error: "Each household item needs an id." };
    }
    if (!item.name_snapshot || typeof item.name_snapshot !== "string") {
      return { ok: false, error: "Each household item needs a name." };
    }
    if (!item.due_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(item.due_date))) {
      return { ok: false, error: "Each household item needs a due date." };
    }
    if (!Number.isFinite(Number(item.amount || 0)) || Number(item.amount || 0) < 0) {
      return { ok: false, error: "Each household item amount must be a number >= 0." };
    }
  }
  const payloadString = safeJsonStringify(payload);
  if (!payloadString) {
    return { ok: false, error: "Invalid household payload." };
  }
  if (Buffer.byteLength(payloadString, "utf8") > MAX_HOUSEHOLD_PAYLOAD_BYTES) {
    return { ok: false, error: "Household payload too large." };
  }
  return { ok: true };
}

function normalizeMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  return Number(amount.toFixed(2));
}

function buildHouseholdInviteUrl(baseUrl, inviteToken) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const token = String(inviteToken || "").trim();
  if (!base || !token) return "";
  return `${base}/?household_invite=${encodeURIComponent(token)}`;
}

function aggregateHouseholdLedger(payload, members, events) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const memberRows = Array.isArray(members) ? members : [];
  const eventRows = Array.isArray(events) ? events : [];
  const memberMap = new Map();
  for (const member of memberRows) {
    if (!member || !member.token) continue;
    memberMap.set(member.token, {
      token: member.token,
      display_name: member.display_name,
      role: member.role,
      is_active: !!member.is_active,
      last_seen_at: member.last_seen_at || null,
    });
  }

  const itemMap = new Map();
  const itemSummaries = [];
  for (const item of items) {
    const normalized = {
      ...item,
      amount: normalizeMoney(item.amount || 0),
      shared_amount_paid: 0,
      shared_remaining: normalizeMoney(item.amount || 0),
      shared_status: Number(item.amount || 0) > 0 ? "open" : "done",
      contributions: [],
    };
    itemMap.set(item.id, normalized);
    itemSummaries.push(normalized);
  }

  const contributionByItem = new Map();
  const contributionByMember = new Map();
  const activity = [];

  for (const event of eventRows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    if (!event || !itemMap.has(event.item_id)) continue;
    const baseItem = itemMap.get(event.item_id);
    const member = memberMap.get(event.member_token) || null;
    const amount = normalizeMoney(event.amount || 0);
    const actorName = member?.display_name || event.member_name || "Member";
    const itemName = baseItem.name_snapshot || "Bill";

    if (event.type === "contribution") {
      const currentItem = contributionByItem.get(event.item_id) || new Map();
      currentItem.set(event.member_token, normalizeMoney((currentItem.get(event.member_token) || 0) + amount));
      contributionByItem.set(event.item_id, currentItem);
      contributionByMember.set(
        event.member_token,
        normalizeMoney((contributionByMember.get(event.member_token) || 0) + amount)
      );
    }

    activity.push({
      id: event.id,
      item_id: event.item_id,
      item_name: itemName,
      member_token: event.member_token,
      member_name: actorName,
      type: event.type,
      amount,
      note: event.note || null,
      created_at: event.created_at,
    });
  }

  for (const item of itemSummaries) {
    const memberContributionMap = contributionByItem.get(item.id) || new Map();
    const contributions = Array.from(memberContributionMap.entries())
      .map(([memberToken, amount]) => ({
        member_token: memberToken,
        member_name: memberMap.get(memberToken)?.display_name || "Member",
        amount,
      }))
      .sort((a, b) => b.amount - a.amount || a.member_name.localeCompare(b.member_name));
    const sharedAmountPaid = contributions.reduce((sum, row) => sum + row.amount, 0);
    item.contributions = contributions;
    item.shared_amount_paid = normalizeMoney(sharedAmountPaid);
    item.shared_remaining = normalizeMoney(Math.max(0, item.amount - sharedAmountPaid));
    item.shared_status =
      item.shared_remaining <= 0 ? "done" : item.shared_amount_paid > 0 ? "partial" : "open";
  }

  const memberTotals = memberRows.map((member) => ({
    token: member.token,
    display_name: member.display_name,
    role: member.role,
    is_active: !!member.is_active,
    last_seen_at: member.last_seen_at || null,
    contributed: normalizeMoney(contributionByMember.get(member.token) || 0),
  }));

  const totalDue = normalizeMoney(itemSummaries.reduce((sum, item) => sum + item.amount, 0));
  const totalContributed = normalizeMoney(
    itemSummaries.reduce((sum, item) => sum + item.shared_amount_paid, 0)
  );
  const totalRemaining = normalizeMoney(Math.max(0, totalDue - totalContributed));

  return {
    summary: {
      item_count: itemSummaries.length,
      done_count: itemSummaries.filter((item) => item.shared_status === "done").length,
      open_count: itemSummaries.filter((item) => item.shared_status !== "done").length,
      total_due: totalDue,
      total_contributed: totalContributed,
      total_remaining: totalRemaining,
    },
    items: itemSummaries.sort(
      (a, b) =>
        String(a.due_date).localeCompare(String(b.due_date)) ||
        String(a.name_snapshot).localeCompare(String(b.name_snapshot), undefined, {
          sensitivity: "base",
        })
    ),
    members: memberTotals.sort((a, b) => {
      if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
      return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" });
    }),
    activity: activity.slice(0, MAX_HOUSEHOLD_EVENTS),
  };
}

module.exports = {
  MAX_HOUSEHOLD_ITEMS,
  MAX_HOUSEHOLD_PAYLOAD_BYTES,
  generateHouseholdId,
  generateHouseholdOwnerKey,
  generateHouseholdMemberToken,
  generateHouseholdInviteToken,
  isValidHouseholdId,
  isValidHouseholdOwnerKey,
  isValidHouseholdMemberToken,
  isValidHouseholdInviteToken,
  sanitizeHouseholdName,
  sanitizeMemberName,
  sanitizeNote,
  safeJsonStringify,
  safeJsonParse,
  parseInviteToken,
  parseInviteExpiresAt,
  buildHouseholdRecoveryCode,
  parseHouseholdRecoveryCode,
  validateHouseholdPayload,
  normalizeMoney,
  buildHouseholdInviteUrl,
  aggregateHouseholdLedger,
};
