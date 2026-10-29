// Unit tests must never reach Superserve: no API key, and any fetch fails loudly.
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  delete process.env.SUPERSERVE_API_KEY;
  delete process.env.SUPERSERVE_BASE_URL;
  vi.stubGlobal('fetch', () => {
    throw new Error('network access is disabled in unit tests');
  });
});
