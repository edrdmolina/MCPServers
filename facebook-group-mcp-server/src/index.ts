#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DataStore } from "./services/dataStore.js";
import { FacebookScraper, extractGroupId } from "./services/scraper.js";
import {
  formatSearchResults,
  formatGroupInfo,
  formatGroupList,
} from "./services/formatters.js";
import {
  ScrapeGroupInputSchema,
  SearchPostsInputSchema,
  ListGroupsInputSchema,
  GetGroupInfoInputSchema,
} from "./schemas/inputs.js";
import type { ScrapeGroupInput, SearchPostsInput, GetGroupInfoInput } from "./schemas/inputs.js";
import { DEFAULT_DATA_DIR, DEFAULT_SCROLL_COUNT } from "./constants.js";

const dataStore = new DataStore(process.env.FACEBOOK_MCP_DATA_DIR ?? DEFAULT_DATA_DIR);

const server = new McpServer({
  name: "facebook-group-mcp-server",
  version: "1.0.0",
});

// ─── fb_scrape_group ────────────────────────────────────────────────────────

server.registerTool(
  "fb_scrape_group",
  {
    title: "Scrape Facebook Group",
    description: `Scrape posts and comments from a Facebook group using Puppeteer.

This opens a real browser to scroll through the group feed and extract posts.
It requires a Chrome profile that is already logged into Facebook.

Set these environment variables before running:
- FACEBOOK_CHROME_USER_DATA_DIR: Path to your Chrome user data directory
  (e.g. ~/Library/Application Support/Google/Chrome on macOS,
   ~/.config/google-chrome on Linux)
- FACEBOOK_CHROME_PATH (optional): Path to Chrome executable if not auto-detected

The scraped data is saved locally and merged with any existing data for the group.

Args:
  - group_url (string): Full Facebook group URL
  - scroll_count (number): How many times to scroll (more = more posts, slower). Default 50.
  - headless (boolean): Run invisible. Set false to watch/debug. Default false.

Returns:
  Summary of scraped data including post count and group name.`,
    inputSchema: ScrapeGroupInputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async (params: ScrapeGroupInput) => {
    try {
      const scraper = new FacebookScraper({
        groupUrl: params.group_url,
        dataDir: process.env.FACEBOOK_MCP_DATA_DIR ?? DEFAULT_DATA_DIR,
        chromePath: process.env.FACEBOOK_CHROME_PATH,
        userDataDir: process.env.FACEBOOK_CHROME_USER_DATA_DIR,
        scrollCount: params.scroll_count ?? DEFAULT_SCROLL_COUNT,
        headless: params.headless ?? false,
      });

      await scraper.launch();
      try {
        const groupData = await scraper.scrapeGroup();
        const merged = await dataStore.mergeGroupData(groupData);
        return {
          content: [
            {
              type: "text" as const,
              text: `Successfully scraped group "${merged.groupName}".\n\n${formatGroupInfo(merged)}`,
            },
          ],
        };
      } finally {
        await scraper.close();
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error scraping group: ${message}\n\nTips:\n- Make sure FACEBOOK_CHROME_USER_DATA_DIR points to a Chrome profile that's logged into Facebook\n- Try running with headless=false to see what's happening\n- Close any existing Chrome windows using the same profile first`,
          },
        ],
      };
    }
  }
);

// ─── fb_search_posts ────────────────────────────────────────────────────────

server.registerTool(
  "fb_search_posts",
  {
    title: "Search Facebook Group Posts",
    description: `Search through previously scraped Facebook group posts and comments by keyword.

This searches the locally stored data — you must run fb_scrape_group first to populate data.
Use fb_list_groups to see which groups have been scraped.

Args:
  - group_id (string): Group ID or URL slug. Use fb_list_groups to see available groups.
  - query (string): Keyword or phrase to search for (case-insensitive).
  - search_comments (boolean): Also search within comments. Default true.
  - limit (number): Max results to return (1-100). Default 20.
  - offset (number): Skip this many results for pagination. Default 0.

Returns:
  Matching posts and/or comments with context snippets and links.`,
    inputSchema: SearchPostsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: SearchPostsInput) => {
    try {
      const data = await dataStore.loadGroupData(params.group_id);
      if (!data) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `No data found for group "${params.group_id}". Run fb_scrape_group first, or use fb_list_groups to see available groups.`,
            },
          ],
        };
      }

      const { results, total } = dataStore.searchPosts(
        data,
        params.query,
        params.search_comments ?? true,
        params.limit ?? 20,
        params.offset ?? 0
      );

      const formatted = formatSearchResults(
        results,
        total,
        params.offset ?? 0,
        params.limit ?? 20,
        params.query
      );

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Search error: ${message}` }],
      };
    }
  }
);

// ─── fb_list_groups ─────────────────────────────────────────────────────────

server.registerTool(
  "fb_list_groups",
  {
    title: "List Scraped Facebook Groups",
    description: `List all Facebook groups that have been scraped and stored locally.

Shows group name, ID, post count, and when it was last scraped.
Use the group_id from the results with fb_search_posts to search a group.

Returns:
  List of available groups with metadata.`,
    inputSchema: ListGroupsInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    try {
      const groupIds = await dataStore.listGroups();
      const groups = await Promise.all(
        groupIds.map(async (id) => ({
          id,
          data: await dataStore.loadGroupData(id),
        }))
      );

      return {
        content: [{ type: "text" as const, text: formatGroupList(groups) }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error listing groups: ${message}` }],
      };
    }
  }
);

// ─── fb_group_info ──────────────────────────────────────────────────────────

server.registerTool(
  "fb_group_info",
  {
    title: "Get Facebook Group Info",
    description: `Get detailed info about a previously scraped Facebook group.

Shows group name, post count, comment count, and last scrape time.

Args:
  - group_id (string): Group ID or slug to get info about.

Returns:
  Group metadata and statistics.`,
    inputSchema: GetGroupInfoInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GetGroupInfoInput) => {
    try {
      const data = await dataStore.loadGroupData(params.group_id);
      if (!data) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `No data found for group "${params.group_id}". Run fb_scrape_group first.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: formatGroupInfo(data) }],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Error: ${message}` }],
      };
    }
  }
);

// ─── Start server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("facebook-group-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
