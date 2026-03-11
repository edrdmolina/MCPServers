#!/usr/bin/env node
/**
 * Coastal Film Lab MCP Server
 *
 * A focused MCP server for Coastal Film Lab's reorder workflow:
 *   1. Pull Shopify collection analytics (inventory + sales velocity)
 *   2. Generate reorder recommendations
 *   3. Write order quantities directly to the Google Sheets procurement sheet
 *
 * Tools:
 *   - coastalfilm_list_collections          — discover Shopify collections
 *   - coastalfilm_collection_inventory      — products + stock in a collection
 *   - coastalfilm_sales_velocity            — units sold per SKU over N days
 *   - coastalfilm_reorder_analysis          — combined analysis: stock + velocity → suggestions
 *   - coastalfilm_read_procurement_sheet    — read current procurement sheet state
 *   - coastalfilm_write_order               — write QTY values to the procurement sheet
 *   - coastalfilm_clear_order               — reset all QTY to 0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  listCollections,
  getCollectionProducts,
  getSalesData,
} from "./shopify.js";

import {
  readProcurementSheet,
  writeOrderQuantities,
  clearOrderQuantities,
} from "./sheets.js";

import type { ReorderItem } from "./constants.js";

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

function handleError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes("401") || error.message.includes("Unauthorized")) {
      return "Error: Authentication failed. Check your SHOPIFY_ACCESS_TOKEN or Google service account credentials.";
    }
    if (error.message.includes("403") || error.message.includes("Forbidden")) {
      return "Error: Permission denied. Ensure the Shopify app has read_products, read_orders, read_inventory scopes, and the Google Sheet is shared with the service account.";
    }
    if (error.message.includes("404") || error.message.includes("not found")) {
      return `Error: Resource not found. ${error.message}`;
    }
    if (error.message.includes("429")) {
      return "Error: Rate limit hit. Wait a moment and try again.";
    }
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

// ---------------------------------------------------------------------------
// Server instance
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "coastalfilm-mcp-server",
  version: "1.0.0",
});

// ===========================================================================
// TOOL 1: List Collections
// ===========================================================================

server.registerTool(
  "coastalfilm_list_collections",
  {
    title: "List Shopify Collections",
    description: `List all product collections in the Coastal Film Lab Shopify store.
Use this to discover collection IDs before querying inventory or sales.

Returns: Collection name, handle, ID, and product count for each collection.

Example: "Show me all my Shopify collections" → call with default limit.`,
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25)
        .describe("Max collections to return"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ limit }) => {
    try {
      const collections = await listCollections(limit);
      const lines = ["# Shopify Collections\n"];
      for (const c of collections) {
        lines.push(`- **${c.title}** (${c.productsCount.count} products)`);
        lines.push(`  Handle: \`${c.handle}\` | ID: \`${c.id}\``);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 2: Collection Inventory
// ===========================================================================

server.registerTool(
  "coastalfilm_collection_inventory",
  {
    title: "Collection Inventory Levels",
    description: `Get all products and their current inventory levels for a specific Shopify collection.
Shows each product's variants with SKU, price, and stock quantity.

Args:
  - collection_id: The Shopify collection GID or numeric ID (get from coastalfilm_list_collections)
  - low_stock_threshold: Only show items at or below this stock level (0 = show all)

Returns: Product list with variant-level SKU, price, and inventory quantity.

Example: "What's in stock in my 35mm film collection?" → provide the collection ID.`,
    inputSchema: {
      collection_id: z.string()
        .describe("Shopify collection GID or numeric ID"),
      low_stock_threshold: z.number().int().min(0).default(0)
        .describe("Show only items at/below this stock level (0 = show all)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ collection_id, low_stock_threshold }) => {
    try {
      const products = await getCollectionProducts(collection_id);
      const lines = ["# Collection Inventory\n"];
      let totalProducts = 0;
      let lowStockCount = 0;

      for (const p of products) {
        const variants = low_stock_threshold > 0
          ? p.variants.filter((v) => v.inventoryQuantity <= low_stock_threshold)
          : p.variants;

        if (variants.length === 0 && low_stock_threshold > 0) continue;

        totalProducts++;
        lines.push(`## ${p.title}`);
        lines.push(`Total inventory: ${p.totalInventory}\n`);

        for (const v of variants) {
          const stockWarning = v.inventoryQuantity <= 5 ? " ⚠️ LOW" : "";
          if (v.inventoryQuantity <= 5) lowStockCount++;
          lines.push(
            `- SKU: \`${v.sku}\` | Stock: **${v.inventoryQuantity}**${stockWarning} | Price: $${v.price}`
          );
        }
        lines.push("");
      }

      lines.unshift(
        `Showing ${totalProducts} products${low_stock_threshold > 0 ? ` (≤${low_stock_threshold} stock)` : ""}` +
        ` | ${lowStockCount} items critically low (≤5)\n`
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 3: Sales Velocity
// ===========================================================================

server.registerTool(
  "coastalfilm_sales_velocity",
  {
    title: "Sales Velocity Report",
    description: `Get sales velocity (units sold) for products over a recent period.
Pulls order line items and aggregates by SKU. Sorted by highest sellers first.

Args:
  - days_back: How many days of order history to analyze (default: 30)
  - sku_filter: Optional comma-separated list of SKUs to filter

Returns: Per-SKU breakdown of units sold, revenue, and weekly velocity.

Example: "What are my best sellers in the last 30 days?" → call with days_back=30.`,
    inputSchema: {
      days_back: z.number().int().min(1).max(365).default(30)
        .describe("Number of days of sales history to analyze"),
      sku_filter: z.string().optional()
        .describe("Comma-separated SKU list to filter (omit for all SKUs)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ days_back, sku_filter }) => {
    try {
      const skus = sku_filter
        ? sku_filter.split(",").map((s) => s.trim()).filter(Boolean)
        : undefined;

      const sales = await getSalesData(days_back, skus);
      const weeks = days_back / 7;

      const lines = [`# Sales Velocity Report (Last ${days_back} Days)\n`];
      lines.push(`| SKU | Title | Units Sold | Revenue | Weekly Avg |`);
      lines.push(`|-----|-------|-----------|---------|------------|`);

      for (const s of sales) {
        const weekly = (s.unitsSold / weeks).toFixed(1);
        lines.push(
          `| \`${s.sku}\` | ${s.title} | ${s.unitsSold} | $${s.revenue.toFixed(2)} | ${weekly}/wk |`
        );
      }

      if (sales.length === 0) {
        lines.push("\n_No sales found for the specified period/filters._");
      }

      lines.push(`\n**Total SKUs with sales:** ${sales.length}`);
      lines.push(`**Total units sold:** ${sales.reduce((a, s) => a + s.unitsSold, 0)}`);
      lines.push(
        `**Total revenue:** $${sales.reduce((a, s) => a + s.revenue, 0).toFixed(2)}`
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 4: Reorder Analysis (the core workflow tool)
// ===========================================================================

server.registerTool(
  "coastalfilm_reorder_analysis",
  {
    title: "Reorder Analysis",
    description: `The main workflow tool. Combines current inventory levels with sales velocity 
to generate smart reorder recommendations.

For each product in the collection, it calculates:
  - Current stock level
  - Weekly sales velocity (from recent orders)
  - Weeks of stock remaining
  - Suggested reorder quantity (to cover target_weeks_of_stock)

Args:
  - collection_id: Shopify collection to analyze
  - days_back: Days of sales history for velocity calculation (default: 30)
  - target_weeks_of_stock: How many weeks of stock to order for (default: 4)
  - min_stock_threshold: Only suggest reorders for items at/below this level (default: 20)

Returns: Reorder recommendation table with suggested quantities per SKU.

Example: "Analyze my 35mm collection and suggest a 4-week reorder" → provide collection_id, target_weeks=4.`,
    inputSchema: {
      collection_id: z.string()
        .describe("Shopify collection GID or numeric ID"),
      days_back: z.number().int().min(7).max(365).default(30)
        .describe("Days of sales history to calculate velocity"),
      target_weeks_of_stock: z.number().min(1).max(52).default(4)
        .describe("Target weeks of stock the order should cover"),
      min_stock_threshold: z.number().int().min(0).default(20)
        .describe("Only suggest reorders for items at/below this stock level"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ collection_id, days_back, target_weeks_of_stock, min_stock_threshold }) => {
    try {
      // 1. Get inventory
      const products = await getCollectionProducts(collection_id);
      const allSkus: string[] = [];
      const inventoryMap = new Map<string, { title: string; stock: number }>();

      for (const p of products) {
        for (const v of p.variants) {
          if (!v.sku) continue;
          allSkus.push(v.sku);
          inventoryMap.set(v.sku, {
            title: v.title === "Default Title" ? p.title : `${p.title} — ${v.title}`,
            stock: v.inventoryQuantity,
          });
        }
      }

      // 2. Get sales velocity
      const sales = await getSalesData(days_back, allSkus);
      const salesMap = new Map(sales.map((s) => [s.sku, s]));
      const weeks = days_back / 7;

      // 3. Build reorder recommendations
      const reorders: ReorderItem[] = [];

      for (const [sku, inv] of inventoryMap) {
        if (inv.stock > min_stock_threshold) continue;

        const salesData = salesMap.get(sku);
        const unitsSold = salesData?.unitsSold ?? 0;
        const weeklyVelocity = unitsSold / weeks;

        // Suggested qty: enough to reach target_weeks from current stock
        const needed = Math.ceil(weeklyVelocity * target_weeks_of_stock) - inv.stock;
        const suggestedQty = Math.max(0, needed);

        // Include if stock is low OR if it's selling (even if not critically low)
        if (suggestedQty > 0 || inv.stock <= 5) {
          reorders.push({
            sku,
            title: inv.title,
            currentStock: inv.stock,
            unitsSoldPeriod: unitsSold,
            weeklyVelocity: Math.round(weeklyVelocity * 10) / 10,
            suggestedQty,
          });
        }
      }

      // Sort: out of stock first, then by velocity descending
      reorders.sort((a, b) => {
        if (a.currentStock === 0 && b.currentStock !== 0) return -1;
        if (b.currentStock === 0 && a.currentStock !== 0) return 1;
        return b.weeklyVelocity - a.weeklyVelocity;
      });

      // 4. Format output
      const lines = [
        `# Reorder Analysis`,
        `**Period:** Last ${days_back} days | **Target:** ${target_weeks_of_stock} weeks of stock | **Threshold:** ≤${min_stock_threshold} units\n`,
        `| SKU | Title | Stock | Sold (${days_back}d) | Wk Velocity | Suggested Qty |`,
        `|-----|-------|-------|----------|-------------|---------------|`,
      ];

      for (const r of reorders) {
        const stockEmoji = r.currentStock === 0 ? "🔴" : r.currentStock <= 5 ? "🟡" : "";
        lines.push(
          `| \`${r.sku}\` | ${r.title} | ${stockEmoji} ${r.currentStock} | ${r.unitsSoldPeriod} | ${r.weeklyVelocity}/wk | **${r.suggestedQty}** |`
        );
      }

      lines.push(`\n**Items needing reorder:** ${reorders.filter((r) => r.suggestedQty > 0).length}`);
      lines.push(`**Total units to order:** ${reorders.reduce((a, r) => a + r.suggestedQty, 0)}`);
      lines.push(`\n_Use \`coastalfilm_write_order\` to push these quantities to your procurement sheet._`);

      // Also return structured data for the write tool
      const structuredContent = {
        reorders: reorders.map((r) => ({
          sku: r.sku,
          title: r.title,
          currentStock: r.currentStock,
          weeklyVelocity: r.weeklyVelocity,
          suggestedQty: r.suggestedQty,
        })),
        summary: {
          itemsNeedingReorder: reorders.filter((r) => r.suggestedQty > 0).length,
          totalUnitsToOrder: reorders.reduce((a, r) => a + r.suggestedQty, 0),
        },
      };

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent,
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 5: Read Procurement Sheet
// ===========================================================================

server.registerTool(
  "coastalfilm_read_procurement_sheet",
  {
    title: "Read Procurement Sheet",
    description: `Read the current state of the Google Sheets procurement sheet.
Shows all products with their SKU, title, current order QTY, and cost.

Args:
  - tab: Sheet tab name (defaults to env GOOGLE_SHEET_TAB, usually "Roberts Procurement")
  - vendor_filter: Optional vendor name to filter by (e.g. "KODAK", "CINESTILL")

Returns: Full procurement sheet contents with vendor, SKU, title, QTY, and cost.`,
    inputSchema: {
      tab: z.string().optional()
        .describe("Sheet tab name (default: from env config)"),
      vendor_filter: z.string().optional()
        .describe("Filter by vendor name (e.g. 'KODAK', 'HARMAN', 'CINESTILL')"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ tab, vendor_filter }) => {
    try {
      let rows = await readProcurementSheet(tab);

      if (vendor_filter) {
        const filter = vendor_filter.toUpperCase();
        rows = rows.filter((r) => r.vendor.toUpperCase().includes(filter));
      }

      const lines = [`# Procurement Sheet${vendor_filter ? ` (${vendor_filter})` : ""}\n`];
      lines.push(`| Vendor | SKU | Title | QTY | Cost | Order Cost |`);
      lines.push(`|--------|-----|-------|-----|------|-----------|`);

      let totalOrderCost = 0;
      for (const r of rows) {
        const orderCost = r.qty * r.cost;
        totalOrderCost += orderCost;
        lines.push(
          `| ${r.vendor} | \`${r.sku}\` | ${r.title} | ${r.qty} | $${r.cost.toFixed(2)} | $${orderCost.toFixed(2)} |`
        );
      }

      lines.push(`\n**Total items:** ${rows.length}`);
      lines.push(`**Items with QTY > 0:** ${rows.filter((r) => r.qty > 0).length}`);
      lines.push(`**Total order cost:** $${totalOrderCost.toFixed(2)}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 6: Write Order Quantities
// ===========================================================================

server.registerTool(
  "coastalfilm_write_order",
  {
    title: "Write Order to Procurement Sheet",
    description: `Write order quantities (QTY column) to the Google Sheets procurement sheet.
Takes a JSON object mapping SKU → quantity and updates each matching row.

Args:
  - orders: JSON string of SKU→quantity pairs, e.g. {"7518251": 50, "7518509": 20}
  - tab: Optional sheet tab name

Returns: Confirmation of which SKUs were updated and any that weren't found.

Example: After running reorder_analysis, pass the suggested quantities here to update the sheet.`,
    inputSchema: {
      orders: z.string()
        .describe('JSON object mapping SKU to order quantity, e.g. {"7518251": 50, "CINE800T36exp": 10}'),
      tab: z.string().optional()
        .describe("Sheet tab name (default: from env config)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ orders, tab }) => {
    try {
      let parsed: Record<string, number>;
      try {
        parsed = JSON.parse(orders);
      } catch {
        return {
          content: [{ type: "text", text: 'Error: Invalid JSON. Expected format: {"SKU": qty, "SKU2": qty}' }],
          isError: true,
        };
      }

      const updates = new Map<string, number>();
      for (const [sku, qty] of Object.entries(parsed)) {
        if (typeof qty !== "number" || qty < 0) {
          return {
            content: [{ type: "text", text: `Error: Invalid quantity for SKU "${sku}". Must be a non-negative number.` }],
            isError: true,
          };
        }
        updates.set(sku, qty);
      }

      const result = await writeOrderQuantities(updates, tab);

      const lines = ["# Procurement Sheet Updated\n"];
      if (result.updated.length > 0) {
        lines.push("**Updated:**");
        for (const u of result.updated) {
          lines.push(`- ✅ ${u}`);
        }
      }
      if (result.notFound.length > 0) {
        lines.push("\n**Not found on sheet (check SKU):**");
        for (const nf of result.notFound) {
          lines.push(`- ❌ ${nf}`);
        }
      }

      lines.push(`\n_${result.updated.length} rows updated, ${result.notFound.length} not found._`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// TOOL 7: Clear Order
// ===========================================================================

server.registerTool(
  "coastalfilm_clear_order",
  {
    title: "Clear Procurement Order",
    description: `Reset all QTY values to 0 on the procurement sheet.
Use this to clear a previous order before building a new one.

Args:
  - tab: Optional sheet tab name

Returns: Number of rows that were cleared.`,
    inputSchema: {
      tab: z.string().optional()
        .describe("Sheet tab name (default: from env config)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ tab }) => {
    try {
      const count = await clearOrderQuantities(tab);
      return {
        content: [{
          type: "text",
          text: `✅ Cleared ${count} rows — all QTY values set to 0.`,
        }],
      };
    } catch (error) {
      return { content: [{ type: "text", text: handleError(error) }], isError: true };
    }
  }
);

// ===========================================================================
// Start server
// ===========================================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Coastal Film Lab MCP server running via stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
