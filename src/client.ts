/**
 * HTTP client for the Austrian RIS (Rechtsinformationssystem) API v2.6.
 *
 * This module provides a client for querying the Austrian legal information
 * system API, which includes federal law, state law, case law, and other legal
 * documents.
 *
 * API Documentation: https://data.bka.gv.at/ris/api/v2.6/
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici';

import type {
  NormalizedSearchResults,
  RawApiResponse,
  RawDocumentReference,
  RawHitsInfo,
} from './types.js';

// =============================================================================
// Proxy-aware fetch
// =============================================================================

/**
 * Proxy URL resolved once at module load from standard environment variables.
 * Checks HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy in that order.
 * Undefined when no proxy is configured (direct connection).
 *
 * Memoized at module init rather than re-read on every request — env vars do
 * not change at runtime.  If tests mutate process.env, reset this between runs.
 */
const PROXY_URL: string | undefined =
  process.env['HTTPS_PROXY'] ??
  process.env['https_proxy'] ??
  process.env['HTTP_PROXY'] ??
  process.env['http_proxy'];

/**
 * Unified fetch wrapper with proxy support.
 *
 * Without a proxy: delegates to the global fetch() so that test suites can
 * stub it with vi.stubGlobal('fetch', mockFetch) and intercept all calls.
 *
 * With a proxy (HTTPS_PROXY / HTTP_PROXY / … set): uses undici's own fetch()
 * together with a ProxyAgent dispatcher.  Both must come from the same undici
 * build — mixing the npm-installed ProxyAgent with Node's built-in global fetch
 * (a different undici build) causes "invalid onRequestStart method" /
 * UND_ERR_INVALID_ARG at dispatch time.
 */
const _agentCache = new Map<string, ProxyAgent>();
function getProxyAgent(url: string): ProxyAgent {
  let agent = _agentCache.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    _agentCache.set(url, agent);
  }
  return agent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpFetch(url: string, init: Parameters<typeof undiciFetch>[1]): Promise<any> {
  if (!PROXY_URL) {
    // No proxy: use the global fetch so vi.stubGlobal mocks work in tests
    return globalThis.fetch(url, init as RequestInit);
  }
  // Proxy: both dispatcher and fetch must come from the same undici instance
  return undiciFetch(url, { ...init, dispatcher: getProxyAgent(PROXY_URL) });
}

// =============================================================================
// Custom Errors
// =============================================================================

/**
 * Base exception for RIS API errors.
 */
export class RISAPIError extends Error {
  public readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'RISAPIError';
    this.statusCode = statusCode;
  }
}

/**
 * Raised when a request to the RIS API times out.
 */
export class RISTimeoutError extends RISAPIError {
  constructor(message = 'Request to RIS API timed out') {
    super(message);
    this.name = 'RISTimeoutError';
  }
}

/**
 * Raised when JSON parsing fails.
 */
export class RISParsingError extends RISAPIError {
  public readonly originalError?: Error;

  constructor(message: string, originalError?: Error) {
    super(message);
    this.name = 'RISParsingError';
    this.originalError = originalError;
  }
}

// =============================================================================
// RIS Client
// =============================================================================

const BASE_URL = 'https://data.bka.gv.at/ris/api/v2.6/';
const DEFAULT_TIMEOUT = 30000; // 30 seconds in milliseconds

/**
 * Allowed hostnames for document content fetching (SSRF protection).
 */
const ALLOWED_DOCUMENT_HOSTNAMES = ['data.bka.gv.at', 'www.ris.bka.gv.at', 'ris.bka.gv.at'];

/**
 * Validate that a URL points to an allowed RIS domain (HTTPS only).
 */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_DOCUMENT_HOSTNAMES.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Build query parameters for API request.
 * Converts all values to strings and filters out undefined/null values.
 */
function buildParams(params: Record<string, unknown>): URLSearchParams {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      searchParams.set(key, String(value));
    }
  }
  return searchParams;
}

/**
 * Parse JSON response from the RIS API.
 */
function parseJsonResponse(jsonContent: string): RawApiResponse {
  try {
    return JSON.parse(jsonContent) as RawApiResponse;
  } catch (e) {
    throw new RISParsingError(
      `Failed to parse JSON response: ${e instanceof Error ? e.message : String(e)}`,
      e instanceof Error ? e : undefined,
    );
  }
}

/**
 * Extract and normalize search results from parsed API response.
 */
function extractSearchResults(parsedResponse: RawApiResponse): NormalizedSearchResults {
  const searchResult = parsedResponse.OgdSearchResult ?? {};
  const documentResults = searchResult.OgdDocumentResults ?? {};

  // Extract pagination info from Hits element
  const hitsInfo = documentResults.Hits;

  let totalHits = 0;
  let pageNumber = 1;
  let pageSize = 10;

  if (typeof hitsInfo === 'object' && hitsInfo !== null) {
    const hitsObj = hitsInfo as RawHitsInfo;
    totalHits = Number(hitsObj['#text'] ?? 0);
    pageNumber = Number(hitsObj['@pageNumber'] ?? 1);
    pageSize = Number(hitsObj['@pageSize'] ?? 10);
  } else if (hitsInfo !== undefined && hitsInfo !== null) {
    totalHits = Number(hitsInfo);
  }

  // Extract document references
  let docRefs = documentResults.OgdDocumentReference;

  // Ensure docRefs is always an array
  if (docRefs === undefined || docRefs === null) {
    docRefs = [];
  } else if (!Array.isArray(docRefs)) {
    docRefs = [docRefs];
  }

  return {
    hits: totalHits,
    page_number: pageNumber,
    page_size: pageSize,
    documents: docRefs as RawDocumentReference[],
  };
}

/**
 * Make a request to the RIS API.
 */
async function request(
  endpoint: string,
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  const url = new URL(endpoint, BASE_URL);
  url.search = buildParams(params).toString();

  try {
    const response = await httpFetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new RISAPIError(
        `HTTP error ${response.status} for ${endpoint}: ${text}`,
        response.status,
      );
    }

    const jsonText = await response.text();
    const parsed = parseJsonResponse(jsonText);
    return extractSearchResults(parsed);
  } catch (e) {
    if (e instanceof RISAPIError || e instanceof RISParsingError) {
      throw e;
    }

    if (e instanceof Error) {
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw new RISTimeoutError(`Request to ${endpoint} timed out after ${timeout}ms`);
      }
      throw new RISAPIError(`Request failed for ${endpoint}: ${e.message}`);
    }

    throw new RISAPIError(`Request failed for ${endpoint}: ${String(e)}`);
  }
}

/**
 * Search federal law (Bundesrecht).
 */
export async function searchBundesrecht(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Bundesrecht', params, timeout);
}

/**
 * Search state/provincial law (Landesrecht).
 */
export async function searchLandesrecht(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Landesrecht', params, timeout);
}

/**
 * Search case law/jurisprudence (Judikatur).
 */
export async function searchJudikatur(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Judikatur', params, timeout);
}

/**
 * Search district administrative authorities (Bezirke).
 */
export async function searchBezirke(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Bezirke', params, timeout);
}

/**
 * Search municipal law (Gemeinden).
 */
export async function searchGemeinden(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Gemeinden', params, timeout);
}

/**
 * Search miscellaneous legal collections (Sonstige).
 */
export async function searchSonstige(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('Sonstige', params, timeout);
}

/**
 * Search document change history (History).
 */
export async function searchHistory(
  params: Record<string, unknown>,
  timeout = DEFAULT_TIMEOUT,
): Promise<NormalizedSearchResults> {
  return request('History', params, timeout);
}

/**
 * Fetch HTML content from a document URL.
 */
export async function getDocumentContent(url: string, timeout = DEFAULT_TIMEOUT): Promise<string> {
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new RISAPIError(
        `HTTP error ${response.status} fetching document: ${text}`,
        response.status,
      );
    }

    return await response.text();
  } catch (e) {
    if (e instanceof RISAPIError) {
      throw e;
    }

    if (e instanceof Error) {
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw new RISTimeoutError(`Request to document URL timed out after ${timeout}ms`);
      }
      throw new RISAPIError(`Request failed fetching document: ${e.message}`);
    }

    throw new RISAPIError(`Request failed fetching document: ${String(e)}`);
  }
}

// =============================================================================
// Direct Document URL Construction
// =============================================================================

/**
 * Validate dokumentnummer contains only safe characters.
 * Defense-in-depth check in addition to Zod schema.
 *
 * Valid dokumentnummern:
 * - Start with uppercase letter
 * - Contain only uppercase letters, digits, and underscores
 * - Length between 5 and 50 characters
 *
 * Examples: NOR40052761, BVWG_W123_2000000_1_00
 */
export function isValidDokumentnummer(dokumentnummer: string): boolean {
  if (dokumentnummer.length < 5 || dokumentnummer.length > 50) {
    return false;
  }
  // Only uppercase letters, digits, underscores allowed
  // Must start with uppercase letter
  return /^[A-Z][A-Z0-9_]+$/.test(dokumentnummer);
}

/**
 * URL patterns for different document types based on Dokumentnummer prefix.
 * The {dokumentnummer} placeholder will be replaced with the actual document number.
 */
const DOCUMENT_URL_PATTERNS: Record<string, string> = {
  // Bundesrecht (Federal Law)
  NOR: 'https://ris.bka.gv.at/Dokumente/Bundesnormen/{dokumentnummer}/{dokumentnummer}.html',

  // Landesrecht (State Law) - one prefix per state
  LBG: 'https://ris.bka.gv.at/Dokumente/LrBgld/{dokumentnummer}/{dokumentnummer}.html',
  LKT: 'https://ris.bka.gv.at/Dokumente/LrK/{dokumentnummer}/{dokumentnummer}.html',
  LNO: 'https://ris.bka.gv.at/Dokumente/LrNO/{dokumentnummer}/{dokumentnummer}.html',
  LOO: 'https://ris.bka.gv.at/Dokumente/LrOO/{dokumentnummer}/{dokumentnummer}.html',
  LSB: 'https://ris.bka.gv.at/Dokumente/LrSbg/{dokumentnummer}/{dokumentnummer}.html',
  LST: 'https://ris.bka.gv.at/Dokumente/LrStmk/{dokumentnummer}/{dokumentnummer}.html',
  LTI: 'https://ris.bka.gv.at/Dokumente/LrT/{dokumentnummer}/{dokumentnummer}.html',
  LVB: 'https://ris.bka.gv.at/Dokumente/LrVbg/{dokumentnummer}/{dokumentnummer}.html',
  LWI: 'https://ris.bka.gv.at/Dokumente/LrW/{dokumentnummer}/{dokumentnummer}.html',

  // Judikatur (Case Law)
  JWR: 'https://ris.bka.gv.at/Dokumente/Vwgh/{dokumentnummer}/{dokumentnummer}.html',
  JFR: 'https://ris.bka.gv.at/Dokumente/Vfgh/{dokumentnummer}/{dokumentnummer}.html',
  JFT: 'https://ris.bka.gv.at/Dokumente/Vfgh/{dokumentnummer}/{dokumentnummer}.html',
  JWT: 'https://ris.bka.gv.at/Dokumente/Justiz/{dokumentnummer}/{dokumentnummer}.html',
  JJR: 'https://ris.bka.gv.at/Dokumente/Justiz/{dokumentnummer}/{dokumentnummer}.html',
  BVWG: 'https://ris.bka.gv.at/Dokumente/Bvwg/{dokumentnummer}/{dokumentnummer}.html',
  LVWG: 'https://ris.bka.gv.at/Dokumente/Lvwg/{dokumentnummer}/{dokumentnummer}.html',
  DSB: 'https://ris.bka.gv.at/Dokumente/Dsk/{dokumentnummer}/{dokumentnummer}.html',
  GBK: 'https://ris.bka.gv.at/Dokumente/Gbk/{dokumentnummer}/{dokumentnummer}.html',
  PVAK: 'https://ris.bka.gv.at/Dokumente/Pvak/{dokumentnummer}/{dokumentnummer}.html',
  ASYLGH: 'https://ris.bka.gv.at/Dokumente/AsylGH/{dokumentnummer}/{dokumentnummer}.html',

  // Bundesgesetzblätter (Federal Law Gazettes)
  BGBLA: 'https://ris.bka.gv.at/Dokumente/BgblAuth/{dokumentnummer}/{dokumentnummer}.html',
  BGBL: 'https://ris.bka.gv.at/Dokumente/BgblAlt/{dokumentnummer}/{dokumentnummer}.html',
  BGBLPDF: 'https://ris.bka.gv.at/Dokumente/BgblPdf/{dokumentnummer}/{dokumentnummer}.html',

  // Regierungsvorlagen (Government Bills)
  REGV: 'https://ris.bka.gv.at/Dokumente/RegV/{dokumentnummer}/{dokumentnummer}.html',

  // Bezirke (District Administrative Authorities)
  BVB: 'https://ris.bka.gv.at/Dokumente/Bvb/{dokumentnummer}/{dokumentnummer}.html',

  // Verordnungsblätter (State Ordinance Gazettes)
  VBL: 'https://ris.bka.gv.at/Dokumente/Vbl/{dokumentnummer}/{dokumentnummer}.html',

  // Sonstige (Miscellaneous)
  MRP: 'https://ris.bka.gv.at/Dokumente/Mrp/{dokumentnummer}/{dokumentnummer}.html',
  ERL: 'https://ris.bka.gv.at/Dokumente/Erlaesse/{dokumentnummer}/{dokumentnummer}.html',
  PRUEF: 'https://ris.bka.gv.at/Dokumente/PruefGewO/{dokumentnummer}/{dokumentnummer}.html',
  AVSV: 'https://ris.bka.gv.at/Dokumente/Avsv/{dokumentnummer}/{dokumentnummer}.html',
  SPG: 'https://ris.bka.gv.at/Dokumente/Spg/{dokumentnummer}/{dokumentnummer}.html',
  KMGER: 'https://ris.bka.gv.at/Dokumente/KmGer/{dokumentnummer}/{dokumentnummer}.html',
};

/**
 * Construct a direct document URL based on the Dokumentnummer prefix.
 *
 * @param dokumentnummer - The RIS document number (e.g., "NOR12019037")
 * @returns The constructed URL or null if prefix is unknown or dokumentnummer is invalid
 */
export function constructDocumentUrl(dokumentnummer: string): string | null {
  // Validate before URL construction (defense-in-depth)
  if (!isValidDokumentnummer(dokumentnummer)) {
    return null;
  }

  // Find matching prefix (check longer prefixes first to avoid false matches)
  const prefixes = Object.keys(DOCUMENT_URL_PATTERNS).sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (dokumentnummer.startsWith(prefix)) {
      const pattern = DOCUMENT_URL_PATTERNS[prefix];
      return pattern.replace(/{dokumentnummer}/g, dokumentnummer);
    }
  }

  return null;
}

/**
 * Result type for direct document fetch.
 */
export type DirectDocumentResult =
  | { success: true; html: string; url: string }
  | { success: false; error: string; statusCode?: number };

/**
 * Attempt to fetch a document directly by its Dokumentnummer using URL construction.
 *
 * This bypasses the search API and fetches the document directly if the
 * Dokumentnummer prefix is known.
 *
 * @param dokumentnummer - The RIS document number (e.g., "NOR12019037")
 * @param timeout - Request timeout in milliseconds
 * @returns Result object with HTML content on success, or error details on failure
 */
export async function getDocumentByNumber(
  dokumentnummer: string,
  timeout = DEFAULT_TIMEOUT,
): Promise<DirectDocumentResult> {
  // Validate dokumentnummer before any URL operations
  if (!isValidDokumentnummer(dokumentnummer)) {
    return {
      success: false,
      error: `Ungueltige Dokumentnummer: "${dokumentnummer}". Nur Grossbuchstaben, Ziffern und Unterstriche erlaubt (5-50 Zeichen, muss mit Buchstabe beginnen).`,
    };
  }

  const url = constructDocumentUrl(dokumentnummer);

  if (!url) {
    return {
      success: false,
      error: `Unbekanntes Dokumentnummer-Prefix: ${dokumentnummer.slice(0, 4)}`,
    };
  }

  try {
    const html = await getDocumentContent(url, timeout);
    return { success: true, html, url };
  } catch (e) {
    if (e instanceof RISAPIError) {
      return {
        success: false,
        error: e.message,
        statusCode: e.statusCode,
      };
    }
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
