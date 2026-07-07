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
//   ?days=30   -> how many days back to pull (default 30, max 180)

const BASE = "https://api.apollo.io/api/v1";

exports.handler = async (event) => {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    return respond(500, { error: "APOLLO_API_KEY is not set in Netlify environment variables." });
  }

  const days = Math.min(parseInt(event.queryStringParameters?.days || "30", 10) || 30, 180);
  const maxDate = new Date();
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);

  try {
    // 1. Pull sequence (campaign) names so we can label the per-campaign breakdown.
    const campaignNames = await fetchCampaignNames(apiKey);

    // 2. Pull outreach emails (paginated), scoped to the date window.
    const messages = await fetchAllMessages(apiKey, fmt(minDate), fmt(maxDate));

    // 3. Aggregate.
    const stats = aggregate(messages, campaignNames);

    return respond(200, { generatedAt: new Date().toISOString(), windowDays: days, ...stats });
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

async function fetchAllMessages(apiKey, minDate, maxDate) {
  const perPage = 100;
  const maxPages = 20; // safety cap: up to 2,000 messages
  let all = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await apolloFetch(apiKey, `${BASE}/emailer_messages/search`, {
      page,
      per_page: perPage,
      emailer_message_date_range_mode: "completed_at",
      "emailer_message_date_range[min]": minDate,
      "emailer_message_date_range[max]": maxDate,
    });
    const batch = res.emailer_messages || res.emailer_message || res.messages || [];
    all = all.concat(batch);
    const totalPages = res.pagination?.total_pages || res.total_pages || 1;
    if (page >= totalPages || batch.length < perPage) break;
  }
  return all;
}

async function apolloFetch(apiKey, url, params) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") qs.set(k, v);
  });
  const res = await fetch(`${url}?${qs.toString()}`, {
    method: "GET",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, accept: "application/json" },
  });
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
