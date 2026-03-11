import fs from "fs/promises";
import path from "path";
import { DEFAULT_DATA_DIR } from "../constants.js";
import type { GroupData, SearchResult, FacebookPost } from "../types.js";

export class DataStore {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? DEFAULT_DATA_DIR;
  }

  async ensureDataDir(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }

  private groupFilePath(groupId: string): string {
    return path.join(this.dataDir, `group_${groupId}.json`);
  }

  async saveGroupData(data: GroupData): Promise<void> {
    await this.ensureDataDir();
    const filePath = this.groupFilePath(data.groupId);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async loadGroupData(groupId: string): Promise<GroupData | null> {
    try {
      const filePath = this.groupFilePath(groupId);
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as GroupData;
    } catch {
      return null;
    }
  }

  async listGroups(): Promise<string[]> {
    try {
      await this.ensureDataDir();
      const files = await fs.readdir(this.dataDir);
      return files
        .filter((f) => f.startsWith("group_") && f.endsWith(".json"))
        .map((f) => f.replace("group_", "").replace(".json", ""));
    } catch {
      return [];
    }
  }

  async mergeGroupData(newData: GroupData): Promise<GroupData> {
    const existing = await this.loadGroupData(newData.groupId);
    if (!existing) {
      await this.saveGroupData(newData);
      return newData;
    }

    // Merge by post ID, preferring newer data
    const postMap = new Map<string, FacebookPost>();
    for (const post of existing.posts) {
      postMap.set(post.id, post);
    }
    for (const post of newData.posts) {
      postMap.set(post.id, post);
    }

    const merged: GroupData = {
      ...newData,
      lastScraped: newData.lastScraped,
      posts: Array.from(postMap.values()),
    };

    await this.saveGroupData(merged);
    return merged;
  }

  searchPosts(
    data: GroupData,
    query: string,
    searchComments: boolean,
    limit: number,
    offset: number
  ): { results: SearchResult[]; total: number } {
    const lowerQuery = query.toLowerCase();
    const allResults: SearchResult[] = [];

    for (const post of data.posts) {
      // Search post content
      if (post.content.toLowerCase().includes(lowerQuery)) {
        const snippetStart = Math.max(
          0,
          post.content.toLowerCase().indexOf(lowerQuery) - 60
        );
        const snippetEnd = Math.min(
          post.content.length,
          snippetStart + query.length + 120
        );
        allResults.push({
          type: "post",
          post,
          matchSnippet:
            (snippetStart > 0 ? "..." : "") +
            post.content.slice(snippetStart, snippetEnd) +
            (snippetEnd < post.content.length ? "..." : ""),
        });
      }

      // Search comments
      if (searchComments && post.comments) {
        for (const comment of post.comments) {
          if (comment.content.toLowerCase().includes(lowerQuery)) {
            const snippetStart = Math.max(
              0,
              comment.content.toLowerCase().indexOf(lowerQuery) - 60
            );
            const snippetEnd = Math.min(
              comment.content.length,
              snippetStart + query.length + 120
            );
            allResults.push({
              type: "comment",
              post,
              comment,
              matchSnippet:
                (snippetStart > 0 ? "..." : "") +
                comment.content.slice(snippetStart, snippetEnd) +
                (snippetEnd < comment.content.length ? "..." : ""),
            });
          }
        }
      }
    }

    const total = allResults.length;
    const paged = allResults.slice(offset, offset + limit);

    return { results: paged, total };
  }
}
