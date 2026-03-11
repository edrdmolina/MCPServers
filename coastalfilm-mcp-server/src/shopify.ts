/**
 * Shopify GraphQL Admin API client for Coastal Film Lab.
 *
 * Uses the GraphQL API (not REST) as recommended by Shopify for all new
 * integrations. Handles products-by-collection, inventory levels, and
 * recent order line-item sales data.
 */

import {
  getShopifyConfig,
  SHOPIFY_API_VERSION,
  SHOPIFY_API_FALLBACK_VERSIONS,
  type ShopifyProduct,
  type ShopifyVariant,
  type SalesDataPoint,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Low-level GraphQL helper (with version fallback)
// ---------------------------------------------------------------------------

async function tryFetch<T>(
  domain: string,
  token: string,
  version: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<{ ok: true; data: T } | { ok: false; status: number; text: string }> {
  const url = `https://${domain}/admin/api/${version}/graphql.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, text };
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    return { ok: false, status: 200, text: `GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}` };
  }
  if (!json.data) {
    return { ok: false, status: 200, text: "Shopify returned empty data" };
  }
  return { ok: true, data: json.data };
}

async function shopifyGraphQL<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { domain, token } = getShopifyConfig();

  // Try primary version first
  const primary = await tryFetch<T>(domain, token, SHOPIFY_API_VERSION, query, variables);
  if (primary.ok) return primary.data;

  // If 404, try fallback versions
  if (!primary.ok && primary.status === 404) {
    console.error(`[coastalfilm] API version ${SHOPIFY_API_VERSION} returned 404, trying fallbacks...`);
    for (const fallbackVersion of SHOPIFY_API_FALLBACK_VERSIONS) {
      const result = await tryFetch<T>(domain, token, fallbackVersion, query, variables);
      if (result.ok) {
        console.error(`[coastalfilm] Using fallback API version: ${fallbackVersion}`);
        return result.data;
      }
      console.error(`[coastalfilm] Fallback ${fallbackVersion} failed: ${result.status} ${result.text.substring(0, 100)}`);
    }
  }

  // All versions failed — throw with diagnostic info
  throw new Error(
    `Shopify API failed (domain: ${domain}, version: ${SHOPIFY_API_VERSION}): ` +
    `${primary.status} — ${primary.text.substring(0, 200)}`
  );
}

// ---------------------------------------------------------------------------
// List collections (so Claude can discover which collections exist)
// ---------------------------------------------------------------------------

interface CollectionNode {
  id: string;
  title: string;
  handle: string;
  productsCount: { count: number };
}

export async function listCollections(limit = 25): Promise<CollectionNode[]> {
  const query = `
    query ListCollections($first: Int!) {
      collections(first: $first) {
        edges {
          node {
            id
            title
            handle
            productsCount { count }
          }
        }
      }
    }
  `;

  interface Data {
    collections: { edges: Array<{ node: CollectionNode }> };
  }

  const data = await shopifyGraphQL<Data>(query, { first: limit });
  return data.collections.edges.map((e) => e.node);
}

// ---------------------------------------------------------------------------
// Get products in a collection with inventory
// ---------------------------------------------------------------------------

export async function getCollectionProducts(
  collectionId: string,
  limit = 50
): Promise<ShopifyProduct[]> {
  // collectionId can be a GID or numeric — normalise to GID
  const gid = collectionId.startsWith("gid://")
    ? collectionId
    : `gid://shopify/Collection/${collectionId}`;

  const query = `
    query CollectionProducts($id: ID!, $first: Int!) {
      collection(id: $id) {
        products(first: $first) {
          edges {
            node {
              id
              title
              handle
              totalInventory
              variants(first: 30) {
                edges {
                  node {
                    id
                    sku
                    title
                    price
                    inventoryQuantity
                    inventoryItem { id }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  interface VNode {
    id: string;
    sku: string;
    title: string;
    price: string;
    inventoryQuantity: number;
    inventoryItem: { id: string };
  }
  interface PNode {
    id: string;
    title: string;
    handle: string;
    totalInventory: number;
    variants: { edges: Array<{ node: VNode }> };
  }
  interface Data {
    collection: { products: { edges: Array<{ node: PNode }> } } | null;
  }

  const data = await shopifyGraphQL<Data>(query, { id: gid, first: limit });
  if (!data.collection) throw new Error(`Collection ${collectionId} not found`);

  return data.collection.products.edges.map((pe): ShopifyProduct => {
    const p = pe.node;
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      totalInventory: p.totalInventory,
      variants: p.variants.edges.map((ve): ShopifyVariant => {
        const v = ve.node;
        return {
          id: v.id,
          sku: v.sku,
          title: v.title,
          price: v.price,
          inventoryQuantity: v.inventoryQuantity,
          inventoryItemId: v.inventoryItem.id,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Get sales data via ShopifyQL (accurate aggregation, no pagination needed)
// ---------------------------------------------------------------------------

export async function getSalesData(
  daysBack = 30,
  skuFilter?: string[]
): Promise<SalesDataPoint[]> {
  const shopifyqlQuery = `FROM sales SHOW net_items_sold, gross_sales GROUP BY product_title, product_variant_sku SINCE -${daysBack}d UNTIL today ORDER BY net_items_sold DESC LIMIT 1000`;

  const gqlQuery = `
    query ShopifyQLSales($query: String!) {
      shopifyqlQuery(query: $query) {
        tableData {
          columns {
            name
            dataType
          }
          rows
        }
        parseErrors
      }
    }
  `;

  interface Column {
    name: string;
    dataType: string;
  }
  interface Data {
    shopifyqlQuery: {
      tableData: {
        columns: Column[];
        rows: Record<string, string | null>[];
      } | null;
      parseErrors: string[] | null;
    };
  }

  const data = await shopifyGraphQL<Data>(gqlQuery, { query: shopifyqlQuery });

  if (data.shopifyqlQuery.parseErrors?.length) {
    throw new Error(
      `ShopifyQL parse errors: ${data.shopifyqlQuery.parseErrors.join("; ")}`
    );
  }

  const tableData = data.shopifyqlQuery.tableData;
  if (!tableData || !tableData.rows?.length) {
    return [];
  }

  // Rows are objects keyed by column name, e.g.:
  // { product_title: "...", product_variant_sku: "ABC123", net_items_sold: "150", gross_sales: "1234.56" }
  const skuSet = skuFilter ? new Set(skuFilter) : null;
  const results: SalesDataPoint[] = [];

  for (const row of tableData.rows) {
    const sku = row["product_variant_sku"];
    if (!sku) continue;
    if (skuSet && !skuSet.has(sku)) continue;

    const unitsSold = Number(row["net_items_sold"]) || 0;
    const revenue = Number(row["gross_sales"]) || 0;
    const title = row["product_title"] ?? sku;

    if (unitsSold > 0) {
      results.push({ sku, title, unitsSold, revenue });
    }
  }

  return results.sort((a, b) => b.unitsSold - a.unitsSold);
}

// ---------------------------------------------------------------------------
// Full inventory snapshot (all products, not filtered by collection)
// ---------------------------------------------------------------------------

export async function getInventoryLevels(limit = 100): Promise<
  Array<{ sku: string; title: string; inventoryQuantity: number }>
> {
  const query = `
    query AllProducts($first: Int!) {
      products(first: $first) {
        edges {
          node {
            title
            variants(first: 30) {
              edges {
                node {
                  sku
                  inventoryQuantity
                }
              }
            }
          }
        }
      }
    }
  `;

  interface VNode { sku: string; inventoryQuantity: number }
  interface PNode { title: string; variants: { edges: Array<{ node: VNode }> } }
  interface Data { products: { edges: Array<{ node: PNode }> } }

  const data = await shopifyGraphQL<Data>(query, { first: limit });
  const results: Array<{ sku: string; title: string; inventoryQuantity: number }> = [];

  for (const pe of data.products.edges) {
    for (const ve of pe.node.variants.edges) {
      if (ve.node.sku) {
        results.push({
          sku: ve.node.sku,
          title: pe.node.title,
          inventoryQuantity: ve.node.inventoryQuantity,
        });
      }
    }
  }

  return results;
}
