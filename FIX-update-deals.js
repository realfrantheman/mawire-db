/* ═══════════════════════════════════════════════════════════════
   mergers.news — api/update-deals.js
   Vercel Serverless Function (Cron)
   Schedule: 59 4 * * * (11:59pm EST = 04:59 UTC)

   FIXED:
   - Removed Claude hallucination: Claude has no real-time internet.
     New deals come only from the Railway pipeline (SEC, EU, APAC, RSS).
   - Removed 500-deal cap: deals.json now holds all deals.
   - This function now only triggers the Railway export via a webhook.
   - If RAILWAY_WEBHOOK_URL is not set, it simply returns healthy status.
═══════════════════════════════════════════════════════════════ */

export default async function handler(req, res) {
  // ── SECURITY: verify cron secret ──────────────────────
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    console.warn('[cron] Unauthorized attempt');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const today = new Date().toISOString().split('T')[0];
  console.log(`[cron] Daily health check — ${today}`);

  try {
    // Optional: ping the Railway export webhook to force a fresh export
    const webhookUrl = process.env.RAILWAY_EXPORT_WEBHOOK_URL;
    if (webhookUrl) {
      const webhookRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ trigger: 'vercel-cron', date: today }),
      }).catch(err => ({ ok: false, status: 0, statusText: err.message }));

      if (!webhookRes.ok) {
        console.warn(`[cron] Webhook returned ${webhookRes.status}: ${webhookRes.statusText}`);
      } else {
        console.log('[cron] Railway export webhook triggered successfully');
      }
    }

    // Fetch current deal count from GitHub for reporting
    const ghRes = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_USERNAME}/mawire-db/contents/deals.json`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        }
      }
    ).catch(() => null);

    let dealCount = 'unknown';
    if (ghRes && ghRes.ok) {
      const ghData = await ghRes.json().catch(() => null);
      if (ghData && ghData.size) {
        dealCount = `~${Math.round(ghData.size / 300)} (estimated from file size)`;
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Daily health check complete. New deals are ingested by Railway pipeline.',
      date: today,
      dealCount,
      note: 'Claude is not used for deal generation — all deals come from SEC EDGAR, EU Merger Registry, APAC exchanges, and RSS news feeds via Railway.',
    });

  } catch (err) {
    console.error('[cron] Error:', err.message);
    return res.status(500).json({ error: err.message, date: today });
  }
}
