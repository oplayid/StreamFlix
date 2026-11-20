import { createFileRoute } from "@tanstack/react-router";
import { collection } from "@/lib/mongo";

type SubtitleDoc = { _id: string; content: string };

export const Route = createFileRoute("/api/subtitles/$id")({
  server: {
    handlers: {
      GET: async ({ params }: { params: { id: string } }) => {
        try {
          const col = await collection<SubtitleDoc>("subtitles");
          const doc = await col.findOne({ _id: params.id }, { projection: { content: 1 } });
          if (!doc) return new Response("Subtitle not found", { status: 404 });
          return new Response(doc.content, {
            headers: {
              "Content-Type": "text/vtt; charset=utf-8",
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
            },
          });
        } catch (error) {
          console.error("subtitle serve error", error);
          return new Response("Internal error", { status: 500 });
        }
      },
    },
  },
});
