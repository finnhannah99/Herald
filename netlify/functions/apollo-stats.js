// Netlify Function: pulls Apollo.io outreach email data for the dashboard.
// Requires a MASTER Apollo API key (both the outreach-email search and the
// sequence search endpoints require master-key access).
//
// Setup:
//   1. In Apollo: Settings > Integrations > API > create a MASTER API key.
//   2. In Netlify: Site settings > Environment variables > add APOLLO_API_KEY.
//   3. Redeploy. The dashboard calls GET /.netlify/functions/apollo-stats.
//
// This function returns ONE CHUNK of raw (normalized) messages per call, not a
// fully-aggregated report — Apollo's search endpoint maxes out at 100 records
// per page and only allows ~50 requests/minute, and Netlify functions have a
// hard wall-clock timeout, so pulling everything in a single invocation isn't
// reliable once an account has more than a few hundred sent emails. The
// dashboard calls this repeatedly with an increasing `cursor` and aggregates
// client-side (identical code path to the built-in demo data), stitching
// chunks together and updating the UI as each one arrives.
//
// Query params:
//   ?days=30              -> how many days back to pull (default 30, max 365, or "all")
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD -> explicit custom date range (overrides ?days)
//   ?campaign_ids=id1,id2 -> restrict to specific sequences (comma-separated Apollo campaign ids)
//   ?cursor=1              -> Apollo page number to resume from (default 1)

const BASE = "https://api.apollo.io/api/v1";
const PAGES_PER_CALL = 6; // ~6 Apollo pages (up to 600 messages) per Netlify invocation, paced to stay under both rate and time limits
const PER_PAGE = 100;
const PACING_MS = 1200; // Apollo caps this endpoint at 50 requests/minute

exports.handler = async (event) => {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return respond(500, { error: "APOLLO_API_KEY is not set in Netlify environment variables." });
  }

  const fromParam = event.queryStringParameters?.from;
  const toParam = event.queryStringParameters?.to;
  const hasCustomRange = !!(fromParam && toParam);

  const daysParam = event.queryStringParameters?.days || "30";
  const isAllTime = !hasCustomRange && daysParam === "all";
  const days = !hasCustomRange && !isAllTime ? Math.min(parseInt(daysParam, 10) || 30, 365) : null;

  const campaignIds = (event.queryStringParameters?.campaign_ids || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const startCursor = Math.max(1, parseInt(event.queryStringParameters?.cursor || "1", 10) || 1);

  let minDate = null, maxDate = null;
  if (hasCustomRange) {
    minDate = fromParam;
    maxDate = toParam;
  } else if (!isAllTime) {
    const maxD = new Date();
    const minD = new Date();
    minD.setDate(minD.getDate() - days);
    const fmt = (d) => d.toISOString().slice(0, 10);
    minDate = fmt(minD);
    maxDate = fmt(maxD);
  }

  try {
    // Sequence names — cheap, fetched every call so each chunk can label campaigns
    // and the dashboard always has the full sequence list for its filter chips.
    const campaignNames = await fetchCampaignNames(apiKey);
    const availableCampaigns = Object.entries(campaignNames).map(([id, name]) => ({ id, name }));

    const { messages, nextCursor, hasMore } = await fetchChunk(apiKey, minDate, maxDate, campaignIds, startCursor);
    const normalized = messages.map((m) => normalizeMessage(m, campaignNames));

    return respond(200, {
      generatedAt: new Date().toISOString(),
      windowDays: hasCustomRange ? null : (isAllTime ? "all" : days),
      customRange: hasCustomRange ? { from: fromParam, to: toParam } : null,
      availableCampaigns,
      messages: normalized,
      cursor: startCursor,
      nextCursor,
      hasMore,
    });
  } catch (err) {
    return respond(502, { error: String(err && err.message ? err.message : err) });
  }
};

async function fetchCampaignNames(apiKey) {
  const map = {};
  try {
    const res = await apolloFetch(apiKey, `${BASE}/emailer_campaigns/search`, { per_page: 100, page: 1 });
    const list = res.emailer_campaigns || res.emailer_campaign || res.campaigns || [];
    for (const c of list) {
      if (c && c.id) map[c.id] = c.name || c.title || `Sequence ${c.id.slice(-5)}`;
    }
  } catch (e) {
    // Non-fatal — dashboard falls back to raw campaign ids.
  }
  return map;
}

async function fetchChunk(apiKey, minDate, maxDate, campaignIds, startCursor) {
  let all = [];
  let page = startCursor;
  let hasMore = true;
  for (let i = 0; i < PAGES_PER_CALL; i++) {
    const params = { page, per_page: PER_PAGE };
    if (minDate && maxDate) {
      params.emailer_message_date_range_mode = "completed_at";
      params["emailer_message_date_range[min]"] = minDate;
      params["emailer_message_date_range[max]"] = maxDate;
    }
    const res = await apolloFetch(apiKey, `${BASE}/emailer_messages/search`, params, campaignIds && campaignIds.length ? { "emailer_campaign_ids[]": campaignIds } : {});
    const batch = res.emailer_messages || res.emailer_message || res.messages || [];
    all = all.concat(batch);
    page += 1;
    if (batch.length < PER_PAGE) {
      hasMore = false;
      break;
    }
    if (i < PAGES_PER_CALL - 1) await sleep(PACING_MS);
  }
  return { messages: all, nextCursor: page, hasMore };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apolloFetch(apiKey, url, params, arrayParams, attempt = 1) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  });
  if (arrayParams) {
    Object.entries(arrayParams).forEach(([k, arr]) => {
      (arr || []).forEach((v) => qs.append(k, v));
    });
  }
  const res = await fetch(`${url}?${qs.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, accept: "application/json" },
  });
  if (res.status === 429 && attempt <= 3) {
    const retryAfterHeader = parseFloat(res.headers.get("retry-after"));
    const waitMs = !isNaN(retryAfterHeader) ? retryAfterHeader * 1000 : attempt * 3000;
    await sleep(waitMs);
    return apolloFetch(apiKey, url, params, arrayParams, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apollo API ${res.status} on ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function normalizeMessage(m, campaignNames) {
  const status = (m.status || m.state || m.emailer_message_stat || "").toLowerCase() || "unknown";
  const campaignId = m.emailer_campaign_id || m.campaign_id || (m.emailer_campaign && m.emailer_campaign.id) || "unassigned";
  const campaignName = campaignNames[campaignId] || (m.emailer_campaign && m.emailer_campaign.name) || (campaignId === "unassigned" ? "No sequence" : campaignId);
  const sentAt = m.completed_at || m.due_at || m.created_at || null;
  return {
    to: m.to_email || (m.to_emails && m.to_emails[0]) || m.contact_email || "—",
    subject: m.subject || m.subject_line || "(no subject)",
    status,
    campaignId,
    campaignName,
    sentAt,
    replied: !!(m.reply_class || m.emailer_message_reply_class),
  };
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
