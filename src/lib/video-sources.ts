import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { collection } from "./mongo";

export type Subtitle = {
  lang: string;
  label: string;
  url: string;
};

export type VideoSource = {
  id: string;
  tmdb_id: string;
  title: string;
  video_url: string;
  type: "movie" | "tv";
  subtitles?: Subtitle[];
};

type VideoSourceDoc = VideoSource & { _id: string };

const getOne = createServerFn({ method: "GET" })
  .validator(z.object({ tmdbId: z.string() }))
  .handler(async ({ data }): Promise<VideoSource | null> => {
    const col = await collection<VideoSourceDoc>("movie_sources");
    const doc = await col.findOne({ _id: data.tmdbId });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return { ...rest, id: _id };
  });

const listAll = createServerFn({ method: "GET" }).handler(async (): Promise<VideoSource[]> => {
  const col = await collection<VideoSourceDoc>("movie_sources");
  const docs = await col.find({}).toArray();
  return docs.map(({ _id, ...rest }) => ({ ...rest, id: _id }));
});

export async function getVideoSource(tmdbId: string): Promise<VideoSource | null> {
  return getOne({ data: { tmdbId } });
}

export async function listVideoSources(): Promise<VideoSource[]> {
  return listAll();
}
