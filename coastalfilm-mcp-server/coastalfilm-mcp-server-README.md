# Coastal Film Lab MCP Server

A custom MCP (Model Context Protocol) server built for Coastal Film Lab's reorder workflow. Connects Shopify analytics with your Google Sheets procurement sheet so you can manage inventory replenishment directly from Claude Cowork.

## What It Does

| Tool | Purpose |
|------|---------|
| `coastalfilm_list_collections` | Discover your Shopify collections and their IDs |
| `coastalfilm_collection_inventory` | See current stock levels for all products in a collection |
| `coastalfilm_sales_velocity` | Analyze sales per SKU over any time period |
| `coastalfilm_reorder_analysis` | **The main tool** — combines stock + velocity → reorder suggestions |
| `coastalfilm_read_procurement_sheet` | Read your current Google Sheet order state |
| `coastalfilm_write_order` | Write QTY values directly to your procurement sheet |
| `coastalfilm_clear_order` | Reset all QTY to 0 before building a new order |

## Workflow Example

Open Claude Cowork and say:

> "Check my Shopify 35mm film collection — what's running low? Cross-reference with the last 30 days of sales and build me a 4-week reorder. Write it to my Roberts procurement sheet."

Claude will:
1. Call `coastalfilm_list_collections` to find the right collection
2. Call `coastalfilm_reorder_analysis` with your collection ID
3. Show you a table of what needs reordering and suggested quantities
4. Call `coastalfilm_write_order` to push the QTY values to your Google Sheet

---

## Setup Guide

### Prerequisites

- **Node.js 18+** installed on your machine
- **Claude Desktop** (latest version) with a Pro, Max, Team, or Enterprise plan
- **Shopify Custom App** with Admin API access
- **Google Cloud Service Account** with Sheets API access

### Step 1: Clone and Build

```bash
git clone <your-repo-url> coastalfilm-mcp-server
cd coastalfilm-mcp-server
npm install
npm run build
```

### Step 2: Create a Shopify Custom App

1. In your Shopify admin, go to **Settings → Apps and sales channels**
2. Click **Develop apps** (enable if needed)
3. Click **Create an app** → name it "Coastal Film Lab MCP"
4. Click **Configure Admin API scopes** and enable:
   - `read_products`
   - `read_orders`
   - `read_inventory`
5. Click **Install app** and copy the **Admin API access token**

### Step 3: Set Up Google Sheets Access

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use an existing one)
3. Enable the **Google Sheets API** and **Google Drive API**
4. Go to **APIs & Services → Credentials → Create Credentials → Service Account**
5. Create the service account and download the JSON key file
6. Save the JSON key as `service-account.json` in this project folder
7. **Share your procurement Google Sheet** with the service account email
   (it looks like `something@your-project.iam.gserviceaccount.com`) — give it **Editor** access

### Step 4: Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your real values:

```
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxxxxxxx
SHOPIFY_STORE_DOMAIN=coastal-film-lab.myshopify.com
GOOGLE_SERVICE_ACCOUNT_PATH=./service-account.json
GOOGLE_SPREADSHEET_ID=1NV_GwAYSrOjakffEc5vNBfP0t73LDoCojjjodmVex60
GOOGLE_SHEET_TAB=Roberts Procurement
```

### Step 5: Connect to Claude Desktop / Cowork

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this to the `mcpServers` section:

```json
{
  "mcpServers": {
    "coastalfilm": {
      "command": "node",
      "args": ["/FULL/PATH/TO/coastalfilm-mcp-server/dist/index.js"],
      "env": {
        "SHOPIFY_ACCESS_TOKEN": "shpat_xxxxxxxxxxxxxxxxxxxxx",
        "SHOPIFY_STORE_DOMAIN": "coastal-film-lab.myshopify.com",
        "GOOGLE_SERVICE_ACCOUNT_PATH": "/FULL/PATH/TO/service-account.json",
        "GOOGLE_SPREADSHEET_ID": "1NV_GwAYSrOjakffEc5vNBfP0t73LDoCojjjodmVex60",
        "GOOGLE_SHEET_TAB": "Roberts Procurement"
      }
    }
  }
}
```

> **Important:** Replace `/FULL/PATH/TO/` with the absolute path on your machine.

### Step 6: Restart Claude Desktop

Completely quit and reopen Claude Desktop. You should see the MCP server indicator (hammer icon) at the bottom of the chat input. Click it to verify the 7 Coastal Film tools are listed.

---

## Procurement Sheet Format

The server expects your Google Sheet to have this column layout (which matches your existing sheet):

| Col | Header | Purpose |
|-----|--------|---------|
| A | VENDOR | Vendor name (KODAK, HARMAN, etc.) |
| B | SKU | Product SKU (must match Shopify SKU) |
| C | TITLE | Product name |
| D | QTY | **Order quantity — this is what the server writes** |
| E | COST | Unit cost from vendor |

The server reads SKUs from column B to match against Shopify data, and writes order quantities to column D. Your existing formulas in column L (Order Cost = QTY × COST) will auto-calculate.

### Multi-Tab Support

Your sheet has multiple tabs (Roberts Procurement, BnH Procurement, Batteries, Chemistry). You can target any tab by name:

> "Write the Kodak order to the Roberts Procurement tab and the Ilford order to BnH Procurement"

---

## Troubleshooting

**"Authentication failed"** → Check your Shopify access token hasn't expired. For new apps created after Jan 2026, you may need OAuth client credentials instead of a static token.

**"Permission denied" on Google Sheets** → Make sure you shared the sheet with the service account email (Editor access).

**"Collection not found"** → Run `coastalfilm_list_collections` first to get the correct collection ID.

**SKUs not matching** → The server matches SKUs case-insensitively. Make sure your Shopify variant SKUs match what's in column B of your procurement sheet.

---

## Security Notes

- Your Shopify access token and Google credentials stay on your local machine
- The MCP server runs as a local subprocess — no data is sent to any third party
- Never commit `.env` or `service-account.json` to version control
