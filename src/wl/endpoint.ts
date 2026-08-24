import type { WlConfig } from '../config/schema.js';

export type QueryValue = string | number | boolean | undefined;

/**
 * Builds a WellnessLiving URL from configuration.
 *
 * Nothing here talks to WL - it is the single place that assembles a WL URL, so
 * that no host, region or business id is ever written at a call site. Every WL
 * call gets `id_region` and `k_business` from config automatically; the
 * architecture doc records that these differ between environments (section 2a).
 */
export function buildWlUrl(
  wl: WlConfig,
  path: string,
  query: Readonly<Record<string, QueryValue>> = {},
): string {
  if (!path.startsWith('/')) {
    throw new Error(`WL path must start with "/": received "${path}"`);
  }

  const url = new URL(`${wl.baseUrl}${path}`);
  // Business scoping first, so an explicit override in `query` is still possible
  // but has to be deliberate.
  url.searchParams.set('id_region', String(wl.idRegion));
  url.searchParams.set('k_business', wl.kBusiness);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

/**
 * Builds a URL on the WellnessLiving AUTH host.
 *
 * Separate from buildWlUrl for two reasons: the token endpoint lives on a
 * different host (WL_AUTH_HOST, not WL_API_HOST), and it takes no business
 * scoping - id_region and k_business are meaningless before a token exists, and
 * sending them changes nothing except what ends up in WL's access logs.
 */
export function buildWlAuthUrl(wl: WlConfig, path: string): string {
  if (!path.startsWith('/')) {
    throw new Error(`WL path must start with "/": received "${path}"`);
  }
  return new URL(`${wl.authBaseUrl}${path}`).toString();
}

/** WL endpoint paths. Paths are stable across environments; hosts are not. */
export const WL_PATHS = {
  /** On the AUTH host - build it with buildWlAuthUrl, never buildWlUrl. */
  token: '/oauth2/token',
  business: '/v1/business',
  locationList: '/v1/location/list',
  reportQuery: '/v1/report/query',
  staffList: '/v1/staff/list',
  user: '/v1/user',
  profilePurchaseList: '/v1/profile/purchase/list',
  purchaseReceipt: '/v1/purchase/receipt',
  scheduleClassList: '/v1/schedule/class/list',
  schedulePageList: '/v1/schedule/page/list',
  schedulePageElement: '/v1/schedule/page/element',
  // Per-location: needs a k_location. Business-wide only by iterating locations.
  classesPromotion: '/v1/classes/promotion',
  // Business-wide: answers with no k_location.
  shopCategory: '/v1/shop/category',
  // Per-location: the bookable-service catalogue and its categories. Both need a
  // k_location; a k_service / k_service_category is unique business-wide, so
  // iterating locations and upserting on the key dedupes across them.
  appointmentServiceList: '/v1/appointment/book/service/list',
  appointmentServiceCategory: '/v1/appointment/book/service/category',
} as const;

export type WlPathName = keyof typeof WL_PATHS;
