import "dotenv/config";
import { searchEmails, readEmail } from "./google_client.js";

export async function getDeliveryStatus() {
  const accounts = (process.env.GOOGLE_ACCOUNTS || "account1").split(",").map((a) => a.trim());
  const allEmails = [];

  for (const account of accounts) {
    try {
      const results = await searchEmails(
        account,
        "subject:(delivery OR shipped OR dispatched OR tracking OR parcel OR order) newer_than:7d",
        15
      );

      for (const email of results.slice(0, 8)) {
        try {
          const full = await readEmail(account, email.id);
          allEmails.push({
            account,
            from: full.from,
            subject: full.subject,
            date: full.date,
            body: full.body?.slice(0, 2000) || "",
            links: full.links || [],
          });
        } catch {
          allEmails.push({
            account,
            from: email.from,
            subject: email.subject,
            date: email.date,
            body: email.snippet || "",
            links: [],
          });
        }
      }
    } catch (err) {
      console.error(`Delivery search failed for ${account}:`, err.message);
    }
  }

  if (!allEmails.length) return { summary: "No delivery emails found in the past week." };

  return {
    deliveries: allEmails.map((e) => ({
      account: e.account,
      from: e.from,
      subject: e.subject,
      date: e.date,
      snippet: e.body.slice(0, 500),
      trackingLinks: e.links.filter((l) =>
        /track|parcel|delivery|order/i.test(l)
      ).slice(0, 3),
    })),
  };
}
