import { createFileRoute } from "@tanstack/react-router";
import { collection } from "@/lib/mongo";
import { requireUser } from "@/lib/auth";
import { sendPushToUsers } from "@/lib/web-push-server";

const siteUrl = (process.env.VITE_SITE_URL ?? process.env.APP_URL ?? "").replace(/\/+$/, "");

export const Route = createFileRoute("/api/send-notification")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        // The session cookie authenticates admin notification requests.
        try {
          await requireUser();
        } catch {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        try {
          const body = (await request.json()) as {
            title?: string;
            body?: string;
            target?: "all" | "vip" | "specific";
            specificUserIds?: string[];
            imageUrl?: string;
            clickAction?: string;
          };
          if (!body.title || !body.body) {
            return Response.json({ error: "Title and body are required" }, { status: 400 });
          }

          const users = await collection<{ _id: string; vip?: boolean }>("users");
          const allUsers = await users.find({}, { projection: { _id: 1, vip: 1 } }).toArray();
          let userIds = allUsers.map((u) => u._id);

          if (body.target === "vip") {
            const vipCol = await collection<{ _id: string }>("vip");
            const vipDocs = await vipCol.find({}).toArray();
            const vipIds = new Set(vipDocs.map((d) => d._id));
            userIds = userIds.filter((id) => vipIds.has(id) || allUsers.find((u) => u._id === id)?.vip);
          } else if (body.target === "specific" && body.specificUserIds?.length) {
            const wanted = new Set(body.specificUserIds);
            userIds = userIds.filter((id) => wanted.has(id));
          }

          const result = await sendPushToUsers(userIds, {
            title: body.title,
            body: body.body,
            url: body.clickAction || siteUrl || "/",
            ...(body.imageUrl ? { image: body.imageUrl } : {}),
          });
          return Response.json({ ok: true, ...result });
        } catch (err) {
          console.error("send-notification error:", err);
          return Response.json({ error: "Unauthorized or internal error" }, { status: 500 });
        }
      },
    },
  },
});
