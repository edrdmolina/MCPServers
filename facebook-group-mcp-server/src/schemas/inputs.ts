import { z } from "zod";

export const ScrapeGroupInputSchema = z
  .object({
    group_url: z
      .string()
      .url()
      .describe(
        "Full Facebook group URL, e.g. https://www.facebook.com/groups/your-group-name"
      ),
    scroll_count: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        "Number of scroll iterations to load more posts. More scrolls = more posts but slower. Default 50."
      ),
    headless: z
      .boolean()
      .default(false)
      .describe(
        "Run the browser headlessly (invisible). Set false if you need to log in manually. Default false."
      ),
  })
  .strict();

export const SearchPostsInputSchema = z
  .object({
    group_id: z
      .string()
      .min(1)
      .describe(
        "Group ID or slug (from the URL). Use fb_list_groups to see available groups."
      ),
    query: z
      .string()
      .min(1)
      .max(500)
      .describe("Search keyword or phrase to find in posts and comments"),
    search_comments: z
      .boolean()
      .default(true)
      .describe("Whether to also search within comments. Default true."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum results to return. Default 20."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of results to skip for pagination. Default 0."),
  })
  .strict();

export const ListGroupsInputSchema = z.object({}).strict();

export const GetGroupInfoInputSchema = z
  .object({
    group_id: z
      .string()
      .min(1)
      .describe("Group ID or slug to get info about"),
  })
  .strict();

export type ScrapeGroupInput = z.infer<typeof ScrapeGroupInputSchema>;
export type SearchPostsInput = z.infer<typeof SearchPostsInputSchema>;
export type GetGroupInfoInput = z.infer<typeof GetGroupInfoInputSchema>;
