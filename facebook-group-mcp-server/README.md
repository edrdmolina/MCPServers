# facebook-group-mcp-server

An MCP server that lets Claude search through invite-only Facebook groups by scraping them with Puppeteer using your logged-in Chrome profile.

## How It Works

1. **Scrape**: Puppeteer opens your real Chrome browser (already logged into Facebook), navigates to the group, scrolls to load posts, and extracts them.
2. **Store**: Posts and comments are saved as JSON files in `~/.facebook-group-mcp`.
3. **Search**: Claude can then search through the stored data by keyword, across posts and comments.

## Prerequisites

- **Node.js** >= 18
- **Google Chrome** installed
- A Chrome profile that's **already logged into Facebook**

## Setup

### 1. Install dependencies

```bash
cd facebook-group-mcp-server
npm install
npm run build
```

### 2. Find your Chrome user data directory

**macOS:**
```
~/Library/Application Support/Google/Chrome
```

**Linux:**
```
~/.config/google-chrome
```

**Windows:**
```
%LOCALAPPDATA%\Google\Chrome\User Data
```

> **Important:** Close Chrome completely before running the scraper, or use a separate Chrome profile. Puppeteer can't share a profile with a running Chrome instance.

### 3. Configure Claude Desktop

Add this to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "facebook-group": {
      "command": "node",
      "args": ["/Users/edrdmolina/Coastal Film Lab/DevelopmentProjects/facebook-group-mcp-server/dist/index.js"],
      "env": {
        "FACEBOOK_CHROME_PATH": "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "FACEBOOK_CHROME_USER_DATA_DIR": "/Users/edrdmolina/Library/Application Support/BraveSoftware/Brave-Browser/Profile 3",
        "FB_DB_PATH": "/path/to/fb-group-data.db"
      }
    }
  }
}
```

#### Chrome executable paths

**macOS:**
```
/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

**Linux:**
```
/usr/bin/google-chrome
```

**Windows:**
```
C:\Program Files\Google\Chrome\Application\chrome.exe
```

## Usage

Once connected to Claude Desktop, you have these tools:

### `fb_scrape_group`
Scrapes a Facebook group and stores the posts locally.

> "Scrape the Facebook group at https://www.facebook.com/groups/my-cool-group with 100 scrolls"

### `fb_search_posts`
Searches through stored posts and comments.

> "Search the my-cool-group group for posts about 'film processing'"

### `fb_list_groups`
Lists all groups you've previously scraped.

> "What Facebook groups have been scraped?"

### `fb_group_info`
Shows stats about a scraped group.

> "How many posts do we have from my-cool-group?"

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `FACEBOOK_CHROME_USER_DATA_DIR` | Yes | Path to Chrome user data directory |
| `FACEBOOK_CHROME_PATH` | No | Path to Chrome executable |
| `FACEBOOK_MCP_DATA_DIR` | No | Where to store scraped data (default: `~/.facebook-group-mcp`) |

## Tips

- **First scrape**: Run with `headless: false` so you can see the browser and intervene if needed.
- **More posts**: Increase `scroll_count`. 50 scrolls ≈ 50-200 posts depending on the group.
- **Re-scrape**: Running scrape again merges new posts with existing data (deduped by post ID).
- **Close Chrome first**: Puppeteer needs exclusive access to the Chrome profile directory. Close all Chrome windows before scraping, or use a separate profile.
- **Separate profile trick**: Create a dedicated Chrome profile just for scraping: `google-chrome --user-data-dir=~/.chrome-facebook-scraper`. Log into Facebook once in that profile, then use that path as `FACEBOOK_CHROME_USER_DATA_DIR`.

## Limitations

- Facebook's DOM changes frequently. The scraper uses heuristic selectors that may need updating.
- Deeply nested comments may not be captured (only visible/expanded comments are extracted).
- Rate limiting: Don't scrape too aggressively or Facebook may flag the session.
- The scraper extracts what's visible in the rendered DOM — media, polls, and link previews are not captured as structured data.
