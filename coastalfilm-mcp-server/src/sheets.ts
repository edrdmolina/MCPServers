/**
 * Google Sheets client for Coastal Film Lab procurement sheet.
 *
 * Reads and writes to the procurement spreadsheet. Uses a Google Cloud
 * Service Account for authentication (the sheet must be shared with the
 * service account email).
 */

import { google, type sheets_v4 } from "googleapis";
import { readFileSync } from "node:fs";
import {
  getGoogleSheetsConfig,
  type ProcurementRow,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Auth + client singleton
// ---------------------------------------------------------------------------

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheetsClient(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const { serviceAccountPath } = getGoogleSheetsConfig();

  let credentials: { client_email: string; private_key: string };
  try {
    const raw = readFileSync(serviceAccountPath, "utf-8");
    credentials = JSON.parse(raw);
  } catch {
    throw new Error(
      `Could not read service account key at "${serviceAccountPath}". ` +
      "Make sure GOOGLE_SERVICE_ACCOUNT_PATH points to your JSON key file."
    );
  }

  const auth = new google.auth.JWT(
    credentials.client_email,
    undefined,
    credentials.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

// ---------------------------------------------------------------------------
// Read the procurement sheet
// ---------------------------------------------------------------------------

/**
 * Read ALL rows from the procurement tab. Returns rows with their 1-based
 * row index so we can write back to exact cells.
 *
 * Columns (0-indexed): A=Vendor, B=SKU, C=Title, D=QTY, E=Cost, ...
 */
export async function readProcurementSheet(
  tabOverride?: string
): Promise<ProcurementRow[]> {
  const sheets = getSheetsClient();
  const { spreadsheetId, sheetTab } = getGoogleSheetsConfig();
  const tab = tabOverride || sheetTab;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${tab}'!A1:L200`,
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const results: ProcurementRow[] = [];
  let currentVendor = "";

  // Skip header row (index 0) → sheet row 1
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const vendorCell = (row[0] ?? "").toString().trim();
    const sku = (row[1] ?? "").toString().trim();
    const title = (row[2] ?? "").toString().trim();
    const qtyRaw = (row[3] ?? "").toString().replace(/[^0-9.-]/g, "");
    const costRaw = (row[4] ?? "").toString().replace(/[^0-9.-]/g, "");

    // Track current vendor (vendor names appear on "header" rows)
    if (vendorCell && !sku) {
      currentVendor = vendorCell;
      continue;
    }
    if (vendorCell && sku) {
      // Some rows have notes in vendor column (e.g. "13% Margin -")
      // Keep current vendor unless it looks like a real vendor name
      if (!vendorCell.includes("%") && !vendorCell.includes("ORDER")) {
        currentVendor = vendorCell;
      }
    }

    if (!sku) continue; // empty row

    results.push({
      vendor: currentVendor,
      sku,
      title,
      qty: parseFloat(qtyRaw) || 0,
      cost: parseFloat(costRaw) || 0,
      rowIndex: i + 1, // 1-based for Sheets API
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Write QTY values back to the sheet
// ---------------------------------------------------------------------------

/**
 * Update the QTY column (D) for specific SKUs.
 * Takes a map of SKU → quantity and writes each to the correct row.
 */
export async function writeOrderQuantities(
  updates: Map<string, number>,
  tabOverride?: string
): Promise<{ updated: string[]; notFound: string[] }> {
  const sheets = getSheetsClient();
  const { spreadsheetId, sheetTab } = getGoogleSheetsConfig();
  const tab = tabOverride || sheetTab;

  // First read the sheet to find row indices for each SKU
  const allRows = await readProcurementSheet(tab);

  const updated: string[] = [];
  const notFound: string[] = [];
  const batchData: sheets_v4.Schema$ValueRange[] = [];

  for (const [sku, qty] of updates) {
    const row = allRows.find(
      (r) => r.sku.toLowerCase() === sku.toLowerCase()
    );
    if (!row) {
      notFound.push(sku);
      continue;
    }

    batchData.push({
      range: `'${tab}'!D${row.rowIndex}`,
      values: [[qty]],
    });
    updated.push(`${sku} → ${qty}`);
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: batchData,
      },
    });
  }

  return { updated, notFound };
}

// ---------------------------------------------------------------------------
// Clear all QTY values (reset the order)
// ---------------------------------------------------------------------------

export async function clearOrderQuantities(
  tabOverride?: string
): Promise<number> {
  const sheets = getSheetsClient();
  const { spreadsheetId, sheetTab } = getGoogleSheetsConfig();
  const tab = tabOverride || sheetTab;

  const allRows = await readProcurementSheet(tab);
  const batchData: sheets_v4.Schema$ValueRange[] = [];

  for (const row of allRows) {
    if (row.qty > 0) {
      batchData.push({
        range: `'${tab}'!D${row.rowIndex}`,
        values: [[0]],
      });
    }
  }

  if (batchData.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: batchData,
      },
    });
  }

  return batchData.length;
}
