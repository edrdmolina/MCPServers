import puppeteer, { type Browser, type Page } from "puppeteer";
import { SCROLL_DELAY_MS, FACEBOOK_BASE_URL } from "../constants.js";
import type {
  FacebookPost,
  FacebookComment,
  GroupData,
  ScraperConfig,
} from "../types.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts a stable-ish group ID from a Facebook group URL.
 * Works with both numeric IDs and slug-style group names.
 */
export function extractGroupId(groupUrl: string): string {
  const match = groupUrl.match(/facebook\.com\/groups\/([^/?#]+)/);
  if (!match) {
    throw new Error(
      `Invalid Facebook group URL: ${groupUrl}. Expected format: https://www.facebook.com/groups/<group-id-or-name>`
    );
  }
  return match[1];
}

export class FacebookScraper {
  private config: ScraperConfig;
  private browser: Browser | null = null;

  constructor(config: ScraperConfig) {
    this.config = config;
  }

  async launch(): Promise<void> {
    const profileDir = process.env.FACEBOOK_CHROME_PROFILE;
    const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
      headless: this.config.headless,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-notifications",
        ...(profileDir ? [`--profile-directory=${profileDir}`] : []),
      ],
    };

    // Use existing Chrome profile so you're already logged in
    if (this.config.userDataDir) {
      launchOptions.userDataDir = this.config.userDataDir;
    }

    // Use system Chrome if specified
    if (this.config.chromePath) {
      launchOptions.executablePath = this.config.chromePath;
    }

    this.browser = await puppeteer.launch(launchOptions);
    console.error("[scraper] Browser launched");
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.error("[scraper] Browser closed");
    }
  }

  async scrapeGroup(): Promise<GroupData> {
    if (!this.browser) {
      throw new Error("Browser not launched. Call launch() first.");
    }

    const groupId = extractGroupId(this.config.groupUrl);
    const page = await this.browser.newPage();

    try {
      await page.setViewport({ width: 1280, height: 900 });

      // Navigate to the group
      console.error(`[scraper] Navigating to ${this.config.groupUrl}`);
      await page.goto(this.config.groupUrl, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      // Check if we're logged in (look for login form)
      const loginForm = await page.$('form[action*="login"]');
      if (loginForm) {
        throw new Error(
          "Not logged in to Facebook. Ensure your Chrome profile is logged in. " +
            "Set FACEBOOK_CHROME_USER_DATA_DIR to your Chrome profile directory, or " +
            "run with --headless=false to log in manually."
        );
      }

      // Wait for feed content to load
      await sleep(3000);

      // Scroll to load more posts
      console.error(
        `[scraper] Scrolling ${this.config.scrollCount} times to load posts...`
      );
      for (let i = 0; i < this.config.scrollCount; i++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await sleep(SCROLL_DELAY_MS);

        // Click "See more" buttons to expand post content
        await page.evaluate(() => {
          const seeMoreButtons = document.querySelectorAll(
            '[role="button"]'
          );
          seeMoreButtons.forEach((btn) => {
            const text = btn.textContent?.trim().toLowerCase();
            if (text === "see more") {
              (btn as HTMLElement).click();
            }
          });
        });

        if ((i + 1) % 10 === 0) {
          console.error(`[scraper] Scrolled ${i + 1}/${this.config.scrollCount}`);
        }
      }

      // Extract posts from the page
      console.error("[scraper] Extracting posts...");
      const posts = await this.extractPosts(page);

      // Extract group name
      const groupName = await page
        .evaluate(() => {
          const h1 = document.querySelector("h1");
          return h1?.textContent?.trim() ?? "Unknown Group";
        });

      console.error(`[scraper] Extracted ${posts.length} posts from "${groupName}"`);

      return {
        groupId,
        groupName,
        lastScraped: new Date().toISOString(),
        posts,
      };
    } finally {
      await page.close();
    }
  }

  private async extractPosts(page: Page): Promise<FacebookPost[]> {

    // Facebook's DOM is heavily obfuscated, so we use a heuristic approach.
    // We look for post-like containers based on known structural patterns.
    const rawPosts = await page.evaluate((baseUrl: string) => {
      const posts: Array<{
        id: string;
        author: string;
        content: string;
        timestamp: string;
        url: string;
        commentTexts: Array<{ author: string; content: string; timestamp: string }>;
      }> = [];

      // Strategy: find all feed story containers
      // Facebook wraps posts in elements with role="article"
      const articles = document.querySelectorAll('[role="article"]');

      let postIndex = 0;
      articles.forEach((article) => {
        try {
          // Get post text content
          // The main post text is usually inside a div with dir="auto" attribute
          const textElements = article.querySelectorAll(
            '[data-ad-preview="message"] div[dir="auto"], [data-ad-comet-preview="message"] div[dir="auto"]'
          );

          let content = "";
          if (textElements.length > 0) {
            content = Array.from(textElements)
              .map((el) => el.textContent?.trim())
              .filter(Boolean)
              .join("\n");
          }

          // Fallback: grab any substantial text from the article
          if (!content) {
            const allDirAuto = article.querySelectorAll('div[dir="auto"]');
            const textParts: string[] = [];
            allDirAuto.forEach((el) => {
              const text = el.textContent?.trim();
              if (text && text.length > 20 && !text.startsWith("http")) {
                textParts.push(text);
              }
            });
            content = textParts.join("\n");
          }

          if (!content || content.length < 5) return;

          // Get author - typically the first link with a profile URL
          const authorLink = article.querySelector(
            'a[role="link"][href*="/user/"], a[role="link"][href*="profile.php"], h3 a, h4 a, strong > span'
          );
          const author = authorLink?.textContent?.trim() ?? "Unknown";

          // Get timestamp from abbr or time element, or aria-label with date info
          const timeEl = article.querySelector("abbr, time, [data-utime]");
          const timestamp = timeEl?.textContent?.trim() ?? "";

          // Get permalink
          const permalinkEl = article.querySelector(
            'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"]'
          );
          const url = permalinkEl
            ? new URL(
                permalinkEl.getAttribute("href") ?? "",
                baseUrl
              ).href
            : "";

          // Generate a deterministic-ish ID
          const id =
            url.match(/(?:posts|permalink|story_fbid)[/=](\d+)/)?.[1] ??
            `post_${postIndex}`;

          // Extract comments (if visible)
          const commentEls = article.querySelectorAll(
            'ul[role="list"] li, div[aria-label*="Comment"] > div'
          );
          const commentTexts: Array<{
            author: string;
            content: string;
            timestamp: string;
          }> = [];

          commentEls.forEach((commentEl) => {
            const commentAuthor =
              commentEl.querySelector("a span, strong")?.textContent?.trim() ??
              "Unknown";
            const commentContent =
              commentEl.querySelector('div[dir="auto"]')?.textContent?.trim() ??
              "";
            if (commentContent && commentContent.length > 2) {
              commentTexts.push({
                author: commentAuthor,
                content: commentContent,
                timestamp: "",
              });
            }
          });

          posts.push({
            id,
            author,
            content,
            timestamp,
            url,
            commentTexts,
          });

          postIndex++;
        } catch {
          // Skip malformed posts
        }
      });

      return posts;
    }, FACEBOOK_BASE_URL);

    return rawPosts.map((raw) => ({
      id: raw.id,
      author: raw.author,
      content: raw.content,
      timestamp: raw.timestamp,
      url: raw.url,
      comments: raw.commentTexts.map(
        (c): FacebookComment => ({
          author: c.author,
          content: c.content,
          timestamp: c.timestamp,
        })
      ),
    }));
  }
}
