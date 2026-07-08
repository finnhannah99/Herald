// Netlify Function: emails the candidate's final answers + drafts to Herald
// whenever a Calendly meeting is booked.
//
// Setup:
//   1. Create a free account at https://resend.com and verify a sending domain
//      (or just use their shared onboarding@resend.dev sender for testing).
//   2. In Netlify: Site settings -> Environment variables, add:
//        RESEND_API_KEY   - your Resend API key
//        NOTIFY_TO        - the email address that should receive the notification (you)
//        NOTIFY_FROM      - optional, defaults to "Herald <onboarding@resend.dev>"
//   3. (Optional but recommended, to get the booked date/time and confirmed
//      invitee name/email) In Calendly: Integrations -> API & Webhooks ->
//      create a Personal Access Token. In Netlify, add:
//        CALENDLY_API_KEY - that personal access token
//      Without it, the email still sends, using whatever Calendly's widget
//      reported inline and the name from the questionnaire as a fallback.
//   4. Redeploy. The page POSTs here right after Calendly reports a booking.

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_TO;
  if (!apiKey || !to) {
    return { statusCode: 500, body: JSON.stringify({ error: "RESEND_API_KEY and NOTIFY_TO must be set in Netlify environment variables" }) };
  }
  const from = process.env.NOTIFY_FROM || "Herald <onboarding@resend.dev>";

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { form, drafts, eventUri, inviteeUri } = payload;
  let inviteeName = payload.inviteeName;
  let inviteeEmail = payload.inviteeEmail;
  let bookedAt = null;

  const calendlyKey = process.env.CALENDLY_API_KEY;
  if (calendlyKey && (eventUri || inviteeUri)) {
    try {
      const headers = { Authorization: `Bearer ${calendlyKey}` };
      if (eventUri) {
        const evRes = await fetch(eventUri, { headers });
        if (evRes.ok) {
          const evData = await evRes.json();
          bookedAt = evData.resource && evData.resource.start_time;
        }
      }
      if (inviteeUri) {
        const invRes = await fetch(inviteeUri, { headers });
        if (invRes.ok) {
          const invData = await invRes.json();
          inviteeName = (invData.resource && invData.resource.name) || inviteeName;
          inviteeEmail = (invData.resource && invData.resource.email) || inviteeEmail;
        }
      }
    } catch (err) {
      // Non-fatal — email still sends with whatever we already have.
    }
  }

  const clientName = inviteeName || (form && form.name) || "Unknown";
  const bookedAtFormatted = bookedAt
    ? new Date(bookedAt).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })
    : "Not available";

  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const nl2br = (s) => esc(s).replace(/\n/g, "<br>");

  const formRows = form
    ? Object.entries(form)
        .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:4px 0;font-size:13px;">${esc(Array.isArray(v) ? v.join(", ") : v)}</td></tr>`)
        .join("")
    : "";

  const draftBlocks = (drafts || [])
    .map(
      (d, i) => `
        <div style="margin:0 0 20px;padding:16px 18px;background:#f6f6f8;border-radius:10px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#666;margin-bottom:6px;">Draft ${i + 1} · ${esc(d.approach || "")}</div>
          <div style="font-size:14px;font-weight:600;margin-bottom:8px;">${esc(d.subject || "")}</div>
          <div style="font-size:14px;line-height:1.6;">${nl2br(d.body || "")}</div>
        </div>`
    )
    .join("");

  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="font-size:20px;margin:0 0 4px;">New Herald call booked</h2>
      <table style="border-collapse:collapse;margin:0 0 20px;">
        <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;">Client name</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(clientName)}</td></tr>
        ${inviteeEmail ? `<tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;">Client email</td><td style="padding:4px 0;font-size:14px;">${esc(inviteeEmail)}</td></tr>` : ""}
        <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;white-space:nowrap;">Booked for</td><td style="padding:4px 0;font-size:14px;font-weight:600;">${esc(bookedAtFormatted)}</td></tr>
      </table>
      <h3 style="font-size:15px;margin:0 0 8px;">Answers</h3>
      <table style="border-collapse:collapse;margin-bottom:24px;">${formRows}</table>
      <h3 style="font-size:15px;margin:0 0 8px;">Final drafts</h3>
      ${draftBlocks}
    </div>`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `New call booked — ${clientName}`,
        html,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { statusCode: res.status, body: JSON.stringify({ error: data.message || data }) };
    }
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
