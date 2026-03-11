import type { SearchResult, GroupData } from "../types.js";
import { CHARACTER_LIMIT } from "../constants.js";

export function formatSearchResults(
  results: SearchResult[],
  total: number,
  offset: number,
  limit: number,
  query: string
): string {
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines: string[] = [
    `## Search Results for "${query}"`,
    `Showing ${offset + 1}–${offset + results.length} of ${total} matches\n`,
  ];

  for (const result of results) {
    if (result.type === "post") {
      lines.push(`### Post by ${result.post.author}`);
      if (result.post.timestamp) lines.push(`*${result.post.timestamp}*`);
      lines.push(`> ${result.matchSnippet}`);
      if (result.post.url) lines.push(`[View post](${result.post.url})`);
    } else if (result.type === "comment" && result.comment) {
      lines.push(`### Comment by ${result.comment.author} (on post by ${result.post.author})`);
      lines.push(`> ${result.matchSnippet}`);
      if (result.post.url) lines.push(`[View parent post](${result.post.url})`);
    }
    lines.push("---");
  }

  if (total > offset + limit) {
    lines.push(
      `\n*More results available. Use offset=${offset + limit} to see the next page.*`
    );
  }

  let output = lines.join("\n");
  if (output.length > CHARACTER_LIMIT) {
    output = output.slice(0, CHARACTER_LIMIT) + "\n\n[...output truncated]";
  }
  return output;
}

export function formatGroupInfo(data: GroupData): string {
  const totalComments = data.posts.reduce(
    (sum, p) => sum + (p.comments?.length ?? 0),
    0
  );

  return [
    `## ${data.groupName}`,
    `- **Group ID**: ${data.groupId}`,
    `- **Posts scraped**: ${data.posts.length}`,
    `- **Comments scraped**: ${totalComments}`,
    `- **Last scraped**: ${data.lastScraped}`,
  ].join("\n");
}

export function formatGroupList(groups: Array<{ id: string; data: GroupData | null }>): string {
  if (groups.length === 0) {
    return "No groups have been scraped yet. Use fb_scrape_group to scrape a Facebook group first.";
  }

  const lines = ["## Scraped Facebook Groups\n"];
  for (const g of groups) {
    if (g.data) {
      lines.push(
        `- **${g.data.groupName}** (ID: \`${g.id}\`) — ${g.data.posts.length} posts, last scraped ${g.data.lastScraped}`
      );
    } else {
      lines.push(`- \`${g.id}\` (data unavailable)`);
    }
  }
  return lines.join("\n");
}
