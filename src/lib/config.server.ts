export function getServerConfig() {
  return {
    nodeEnv: import.meta.env.MODE,
    // VITE_* is inlined at build time; process.env covers runtime-only setup.
    tmdbApiKey:
      import.meta.env.VITE_TMDB_API_KEY || process.env.TMDB_API_KEY || import.meta.env.TMDB_API_KEY || "",
  };
}
