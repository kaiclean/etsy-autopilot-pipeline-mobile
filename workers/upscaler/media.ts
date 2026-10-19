/** Accepts a URL, `/api/media/<key>`, `s3:<key>` or a bare object key and returns a source `loadArtworkBytes` reads. */
export function mediaUrlForKey(source: string) {
  if (/^(?:https?:|data:)/i.test(source) || source.startsWith("/api/media/")) return source;
  const key = source.replace(/^s3:/, "");
  return `/api/media/${key.split("/").map(encodeURIComponent).join("/")}`;
}
