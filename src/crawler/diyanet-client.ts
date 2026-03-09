import { Logger } from '@nestjs/common';
import axios, { AxiosError, AxiosInstance } from 'axios';
import * as zlib from 'zlib';
import { AppConfig, getCrawlerSitemapIndexPaths } from '../core/config';
import {
    parseLocationSitemap,
    parseSitemapIndex,
} from './parsers';

export class CrawlerSourceError extends Error {}

function formatException(exc: unknown): string {
  if (exc instanceof AxiosError) {
    const status = exc.response?.status;
    const url = exc.config?.url;
    if (status) return `HTTP ${status} from ${url}`;
    return `${exc.code ?? 'AxiosError'}: ${exc.message}`;
  }
  if (exc instanceof Error) {
    return `${exc.constructor.name}: ${exc.message}`;
  }
  return String(exc);
}

export class DiyanetCrawlerClient {
  private readonly client: AxiosInstance;
  private readonly logger = new Logger(DiyanetCrawlerClient.name);
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.client = axios.create({
      timeout: config.crawlerTimeoutSeconds * 1000,
      maxRedirects: 5,
      headers: {
        'User-Agent': config.crawlerUserAgent,
        Accept: 'application/xml,text/xml,text/html;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      responseType: 'arraybuffer',
    });
  }

  private decodeContent(data: Buffer, url: string, headers: Record<string, string>): Buffer {
    const isGzipUrl = url.toLowerCase().endsWith('.gz');
    const contentEncoding = (headers['content-encoding'] ?? '').toLowerCase();
    const contentType = (headers['content-type'] ?? '').toLowerCase();
    const isGzipResponse =
      contentEncoding.includes('gzip') || contentType.includes('gzip');

    if (isGzipUrl || isGzipResponse) {
      try {
        return zlib.gunzipSync(data);
      } catch {
        // already decompressed
      }
    }
    return data;
  }

  async fetchBytes(url: string, retries = 3): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const response = await this.client.get(url);
        return this.decodeContent(
          Buffer.from(response.data),
          url,
          response.headers as Record<string, string>,
        );
      } catch (err) {
        lastError = err;
        if (attempt < retries - 1) {
          await new Promise((r) =>
            setTimeout(r, Math.min(4000, 500 * Math.pow(2, attempt))),
          );
        }
      }
    }
    throw lastError;
  }

  async fetchPageOnce(
    url: string,
    timeout?: number,
  ): Promise<{ html: string; finalUrl: string; statusCode: number }> {
    try {
      const response = await this.client.get(url, {
        timeout: timeout ? timeout * 1000 : undefined,
        maxRedirects: 5,
        validateStatus: () => true,
      });
      const content = this.decodeContent(
        Buffer.from(response.data),
        url,
        response.headers as Record<string, string>,
      );
      const finalUrl =
        response.request?.res?.responseUrl ?? response.config.url ?? url;
      return {
        html: content.toString('utf-8'),
        finalUrl,
        statusCode: response.status,
      };
    } catch (err) {
      throw err;
    }
  }

  async fetchText(url: string): Promise<string> {
    const content = await this.fetchBytes(url);
    return content.toString('utf-8');
  }

  async fetchLocationUrls(): Promise<string[]> {
    const baseUrl = this.config.crawlerBaseUrl.replace(/\/+$/, '');
    let sitemapUrls: string[] = [];
    const sitemapErrors: string[] = [];
    const paths = getCrawlerSitemapIndexPaths(
      this.config.crawlerSitemapIndexPathsCsv,
    );

    for (const path of paths) {
      const candidate = `${baseUrl}${path}`;
      try {
        const xml = await this.fetchText(candidate);
        const allUrls = parseSitemapIndex(xml);
        if (!allUrls.length) continue;

        sitemapUrls = allUrls.filter((u) => u.includes('/sitemaps/location-'));
        if (sitemapUrls.length) break;

        const directLocUrls = allUrls.filter(
          (u) => u.includes('/tr-TR/') && u.includes('/icin-namaz-vakti'),
        );
        if (directLocUrls.length) {
          return [...new Set(directLocUrls)].sort();
        }
      } catch (exc) {
        sitemapErrors.push(`${candidate}: ${formatException(exc)}`);
      }
    }

    if (!sitemapUrls.length) {
      const details = sitemapErrors.length
        ? sitemapErrors.join('; ')
        : 'No sitemap index candidates produced data';
      throw new CrawlerSourceError(
        `Failed to load sitemap index from source: ${details}`,
      );
    }

    const concurrency = Math.max(1, this.config.crawlerConcurrency);
    const allLocationUrls: string[] = [];

    const chunks: string[][] = [];
    for (let i = 0; i < sitemapUrls.length; i += concurrency) {
      chunks.push(sitemapUrls.slice(i, i + concurrency));
    }

    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map(async (url) => {
          try {
            const xml = await this.fetchText(url);
            return parseLocationSitemap(xml);
          } catch (exc) {
            this.logger.warn(
              `Skipping sitemap: ${url} (${formatException(exc)})`,
            );
            return [];
          }
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allLocationUrls.push(...result.value);
        }
      }
    }

    return [...new Set(allLocationUrls)].sort();
  }
}
