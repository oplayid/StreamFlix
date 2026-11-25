import { createFileRoute } from "@tanstack/react-router";
import { requireUser } from "@/lib/auth";
import {
  checkEarnvidsUpload,
  getEarnvidsAsset,
  publicEarnvidsAsset,
  uploadToEarnvids,
  type EarnvidsMediaType,
} from "@/lib/earnvids";

function unauthorized() {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "internal error";
  console.error("[earnvids] request failed:", message);
  return Response.json({ error: message }, { status: 502 });
}

export const Route = createFileRoute("/api/earnvids-upload")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        try {
          await requireUser();
        } catch {
          return unauthorized();
        }

        try {
          const body = (await request.json()) as {
            type?: EarnvidsMediaType;
            id?: string | number;
            season?: string | number;
            episode?: string | number;
            quality?: string;
            source?: string;
            title?: string;
            filePublic?: boolean;
            force?: boolean;
          };
          // `?force=1` is the documented manual retry for a failed asset; the
          // cooldown still applies to automatic uploads from the watch page.
          const force =
            new URL(request.url).searchParams.get("force") === "1" || body.force === true;
          const asset = await uploadToEarnvids({
            type: body.type as EarnvidsMediaType,
            id: body.id ?? "",
            season: body.season,
            episode: body.episode,
            quality: body.quality,
            source: body.source,
            title: body.title,
            filePublic: body.filePublic,
            force,
          });
          return Response.json({ asset: publicEarnvidsAsset(asset) }, { status: 202 });
        } catch (error) {
          return fail(error);
        }
      },

      GET: async ({ request }: { request: Request }) => {
        try {
          await requireUser();
        } catch {
          return unauthorized();
        }

        try {
          const params = new URL(request.url).searchParams;
          const jobId = params.get("job_id")?.trim();
          const fileCode = params.get("file_code")?.trim();
          if (jobId || fileCode) {
            const asset = await checkEarnvidsUpload(jobId ?? "", fileCode);
            return Response.json({ asset: asset ? publicEarnvidsAsset(asset) : null });
          }

          const type = params.get("type");
          const id = params.get("id");
          if ((type !== "movie" && type !== "tv") || !id) {
            return Response.json({ error: "file_code atau type + id diperlukan" }, { status: 400 });
          }
          const asset = await getEarnvidsAsset(
            type,
            id,
            params.get("season") ?? "1",
            params.get("episode") ?? "1",
            params.get("quality") ?? "",
          );
          return Response.json({ asset: asset ? publicEarnvidsAsset(asset) : null });
        } catch (error) {
          return fail(error);
        }
      },
    },
  },
});
