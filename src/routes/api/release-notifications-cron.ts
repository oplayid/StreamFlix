import { createFileRoute } from "@tanstack/react-router";
import { collection, now } from "@/lib/mongo";
import { sendPushToUsers } from "@/lib/web-push-server";

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function isCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true;
  const schedule = request.headers.get("x-vercel-cron-schedule");
  const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
  return Boolean(schedule) || ua.includes("vercel-cron");
}

type NotificationDoc = {
  _id: string;
  user_id: string;
  movie_id: string;
  title: string;
  release_date: string;
  reminded_at?: Date | null;
};

export const Route = createFileRoute("/api/release-notifications-cron")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        if (!isCronRequest(request)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const col = await collection<NotificationDoc>("release_notifications");
          const due = await col.find({
            release_date: todayUtc(),
            $or: [{ reminded_at: null }, { reminded_at: { $exists: false } }],
          }).toArray();
          if (due.length === 0) return Response.json({ ok: true, sent: 0 });

          const byUser = new Map<string, NotificationDoc[]>();
          for (const item of due) {
            const list = byUser.get(item.user_id) ?? [];
            list.push(item);
            byUser.set(item.user_id, list);
          }

          const siteUrl = (process.env.VITE_SITE_URL ?? process.env.APP_URL ?? "").replace(/\/+$/, "");
          let sent = 0;
          for (const [userId, items] of byUser) {
            for (const item of items) {
              const result = await sendPushToUsers([userId], {
                title: `${item.title} is now available`,
                body: "Your reminder just landed on OPLAY.ID.",
                movie_id: item.movie_id,
                url: `${siteUrl}/movie/${item.movie_id}`,
              });
              if (result.successCount > 0) {
                sent += result.successCount;
                await col.updateOne({ _id: item._id }, { $set: { reminded_at: now() } });
              }
            }
          }
          return Response.json({ ok: true, sent });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 500 });
        }
      },
    },
  },
});
