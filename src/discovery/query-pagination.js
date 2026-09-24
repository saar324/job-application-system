export function nextQueryPage(cursors, afterIndex) {
  for (let offset = 1; offset <= cursors.length; offset += 1) {
    const index = (afterIndex + offset) % cursors.length;
    if (cursors[index]?.hasMore) return { index,
      query: cursors[index].query, page: cursors[index].page };
  }
  return null;
}
