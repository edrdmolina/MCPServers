/**
 * Constants and shared types for Coastal Film Lab MCP Server.
 */

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------
export const SHOPIFY_API_VERSION = "2026-01";
export const SHOPIFY_API_FALLBACK_VERSIONS = ["2025-10", "2025-07", "2025-04", "2025-01"];
export const CHARACTER_LIMIT = 25_000;

export function getShopifyConfig(): { domain: string; token: string } {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!domain || !token) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN. " +
      "Set them in your environment or .env file."
    );
  }
  return { domain, token };
}

export function getGoogleSheetsConfig(): {
  serviceAccountPath: string;
  spreadsheetId: string;
  sheetTab: string;
} {
  const serviceAccountPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "./service-account.json";
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID || "";
  const sheetTab = process.env.GOOGLE_SHEET_TAB || "Roberts Procurement";
  if (!spreadsheetId) {
    throw new Error(
      "Missing GOOGLE_SPREADSHEET_ID. Set it in your environment or .env file."
    );
  }
  return { serviceAccountPath, spreadsheetId, sheetTab };
}

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  totalInventory: number;
  variants: ShopifyVariant[];
}

export interface ShopifyVariant {
  id: string;
  sku: string;
  title: string;
  price: string;
  inventoryQuantity: number;
  inventoryItemId: string;
}

export interface SalesDataPoint {
  sku: string;
  title: string;
  unitsSold: number;
  revenue: number;
}

export interface ReorderItem {
  sku: string;
  title: string;
  currentStock: number;
  unitsSoldPeriod: number;
  weeklyVelocity: number;
  suggestedQty: number;
}

export interface ProcurementRow {
  vendor: string;
  sku: string;
  title: string;
  qty: number;
  cost: number;
  rowIndex: number; // 1-based row in the sheet
}
