export interface TagState {
  tags: string[];
  archived: boolean;
}
export interface TagAdapter {
  read(): Promise<TagState>;
  write(change: { tags?: string[]; archived?: boolean }): Promise<unknown>;
}

// Discord has no atomic add/remove operation. Always persist the new tag first.
export async function moveTags(
  adapter: TagAdapter,
  source: string,
  destination: string,
) {
  const original = await adapter.read();
  if (source === destination) return { warning: undefined };
  if (!original.tags.includes(source)) {
    if (original.tags.includes(destination)) return { warning: undefined };
    throw new Error(
      "This ticket has changed in Discord. Refresh the board and try again.",
    );
  }
  if (!original.tags.includes(destination) && original.tags.length >= 5) {
    throw new Error(
      "Discord allows five tags. There is no room to add the new tag safely.",
    );
  }
  const warnings: string[] = [];
  let attemptedWrite = false;
  try {
    attemptedWrite = true;
    await adapter.write({
      tags: [...new Set([...original.tags, destination])],
      ...(original.archived ? { archived: false } : {}),
    });
    // Re-read so unrelated changes made in Discord between our requests are retained.
    const current = await adapter.read();
    if (!current.tags.includes(destination)) {
      throw new Error(
        "The destination tag changed in Discord. The original tag was retained.",
      );
    }
    await adapter.write({ tags: current.tags.filter((tag) => tag !== source) });
  } catch (error) {
    warnings.push(
      `Move could not be completed: ${error instanceof Error ? error.message : "Discord request failed"}`,
    );
  } finally {
    if (original.archived && attemptedWrite) {
      try {
        await adapter.write({ archived: true });
      } catch {
        warnings.push(
          "The post could not be closed again. It may now appear as active in Discord.",
        );
      }
    }
  }
  return { warning: warnings.length ? warnings.join(" ") : undefined };
}
