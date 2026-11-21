/**
 * Namespaced localStorage keys were renamed from `streamflix:` to `oplayid:`
 * during the OPLAY.ID rebrand. Read the old key once so existing users keep
 * their consent, device id, watch history, and list.
 */
export function readMigratedStorage(newKey: string, oldKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = window.localStorage.getItem(newKey);
    if (current != null) return current;
    const legacy = window.localStorage.getItem(oldKey);
    if (legacy != null) {
      window.localStorage.setItem(newKey, legacy);
      window.localStorage.removeItem(oldKey);
    }
    return legacy;
  } catch {
    return null;
  }
}

/** Find keys under either prefix while old data is still being migrated. */
export function findMigratedStorageKeys(suffix: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const keys = Object.keys(window.localStorage);
    // New keys first so callers that mutate `keys[0]` never touch legacy data.
    return [
      ...keys.filter((key) => key.startsWith(`oplayid:${suffix}`)),
      ...keys.filter((key) => key.startsWith(`streamflix:${suffix}`)),
    ];
  } catch {
    return [];
  }
}
