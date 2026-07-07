// Netlify Function: pulls Apollo.io outreach email data and returns aggregated
// stats for the dashboard. Requires a MASTER Apollo API key (Search for Outreach
// Emails / Search for Sequences both require master-key access).
//
// Setup:
//   1. In Apollo: Settings > Integrations > API > create a MASTER API key.
//   2. In Netlify: Site settings > Environment variables > add APOLLO_API_KEY.
//   3. Redeploy. The dashboard calls GET /.netlify/functions/apollo-stats.
//
// Optional query params on the function itself:
//   ?days=30              -> how many days back to pull (default 30, max 365, or "all")
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD -> explicit custom date range (overrides ?days)
//   ?campaign_ids=id1,id2 -> restrict to specific sequences (comma-separated Apollo campaign ids)

const BASE = "https://api.apollo.io/api/v1";

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
    // 1. Pull sequence (campaign) names so we can label the per-campaign breakdown
    //    and offer the full list of sequences to filter by, regardless of the
    //    current campaign_ids filter.
    const campaignNames = await fetchCampaignNames(apiKey);

    // 2. Pull outreach emails (paginated), scoped to the date window (if any)
    //    and, optionally, to specific sequences.
    const messages = await fetchAllMessages(apiKey, minDate, maxDate, campaignIds);

    // 3. Aggregate.
    const stats = aggregate(messages, campaignNames);
    const availableCampaigns = Object.entries(campaignNames).map(([id, name]) => ({ id, name }));

    return respond(200, {
      generatedAt: new Date().toISOString(),
      windowDays: hasCustomRange ? null : (isAllTime ? "all" : days),
      customRange: hasCustomRange ? { from: fromParam, to: toParam } : null,
      availableCampaigns,
      ...stats,
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

async function fetchAllMessages(apiKey, minDate, maxDate, campaignIds) {
  const perPage = 100;
  const maxPages = 100; // safety cap: up to 10,000 messages (Apollo allows up to 500 pages/50,000 total)
  const pacingMs = 1300; // stay under Apollo's 50 requests/minute limit on this endpoint
  let all = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = {
      page,
      per_page: perPage,
    };
    if (minDate && maxDate) {
      params.emailer_message_date_range_mode = "completed_at";
      params["emailer_message_date_range[min]"] = minDate;
      params["emailer_message_date_range[max]"] = maxDate;
    }
    const res = await apolloFetch(apiKey, `${BASE}/emailer_messages/search`, params, campaignIds && campaignIds.length ? { "emailer_campaign_ids[]": campaignIds } : {});
    const batch = res.emailer_messages || res.emailer_message || res.messages || [];
    all = all.concat(batch);
    // Stop once a page comes back with fewer than a full page of results — that's
    // the last page. We deliberately don't trust a `total_pages`-style field here:
    // Apollo's pagination metadata key isn't consistently documented, and trusting
    // a missing/mis-keyed field caused this to stop after page 1 previously.
    if (batch.length < perPage) break;
    if (page < maxPages) await sleep(pacingMs);
  }
  return all;
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
  if (res.status === 429 && attempt <= 4) {
    // Rate-limited — back off and retry a few times before giving up.
    const retryAfterHeader = parseFloat(res.headers.get("retry-after"));
    const waitMs = !isNaN(retryAfterHeader) ? retryAfterHeader * 1000 : attempt * 4000;
    await sleep(waitMs);
    return apolloFetch(apiKey, url, params, arrayParams, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apollo API ${res.status} on ${url}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

function aggregate(messages, campaignNames) {
  let sent = 0, delivered = 0, opened = 0, replied = 0, bounced = 0, clicked = 0;
  const byCampaign = {};
  const byDay = {};
  const list = [];

  for (const m of messages) {
    const status = (m.status || m.state || m.emailer_message_stat || "").toLowerCase();
    const campaignId = m.emailer_campaign_id || m.campaign_id || (m.emailer_campaign && m.emailer_campaign.id) || "unassigned";
    const campaignName = campaignNames[campaignId] || (m.emailer_campaign && m.emailer_campaign.name) || (campaignId === "unassigned" ? "No sequence" : campaignId);
    const sentAt = m.completed_at || m.due_at || m.created_at || null;
    const day = sentAt ? sentAt.slice(0, 10) : "unknown";

    sent += 1;
    if (["delivered", "opened", "not_opened", "clicked", "unsubscribed", "demoed"].includes(status) || status) delivered += 1;
    if (["opened", "clicked", "unsubscribed", "demoed"].includes(status)) opened += 1;
    if (status === "clicked") clicked += 1;
    if (status === "bounced") bounced += 1;
    if (m.reply_class || m.emailer_message_reply_class || m.replied) replied += 1;

    if (!byCampaign[campaignId]) byCampaign[campaignId] = { id: campaignId, name: campaignName, sent: 0, opened: 0, replied: 0, bounced: 0 };
    byCampaign[campaignId].sent += 1;
    if (["opened", "clicked", "unsubscribed", "demoed"].includes(status)) byCampaign[campaignId].opened += 1;
    if (m.reply_class || m.emailer_message_reply_class || m.replied) byCampaign[campaignId].replied += 1;
    if (status === "bounced") byCampaign[campaignId].bounced += 1;

    byDay[day] = (byDay[day] || 0) + 1;

    list.push({
      to: m.to_email || (m.to_emails && m.to_emails[0]) || m.contact_email || "—",
      subject: m.subject || m.subject_line || "(no subject)",
      status: status || "unknown",
      campaign: campaignName,
      sentAt,
    });
  }

  list.sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || ""));

  const timeline = Object.entries(byDay)
    .filter(([d]) => d !== "unknown")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));

  return {
    totals: {
      sent,
      delivered,
      opened,
      replied,
      bounced,
      openRate: sent ? opened / sent : 0,
      replyRate: sent ? replied / sent : 0,
      bounceRate: sent ? bounced / sent : 0,
    },
    campaigns: Object.values(byCampaign).sort((a, b) => b.sent - a.sent),
    timeline,
    emails: list.slice(0, 500),
  };
}

function respond(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(obj),
  };
}
