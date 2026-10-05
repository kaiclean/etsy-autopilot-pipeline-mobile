/** Offset pages that stop on a short page, a repeated page, or a hard cap. */
export async function collectPages<T>(fetchPage: (offset: number) => Promise<T[]>, limit = 100, maxPages = 50): Promise<T[]> {
  const all: T[] = [];
  let previousFirst: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(page * limit);
    if (batch.length === 0) break;
    const first = JSON.stringify(batch[0]);
    if (previousFirst != null && first === previousFirst) break;
    previousFirst = first;
    all.push(...batch);
    if (batch.length < limit) break;
  }
  return all;
}
