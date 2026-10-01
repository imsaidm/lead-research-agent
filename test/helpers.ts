import type { Audit, Business } from '../src/schemas.ts';

export function makeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'osm-node-1',
    name: 'Test Plumbing',
    niche: 'plumber',
    website: 'https://test-plumbing.example/',
    phone: '+1 512 555 0100',
    address: '1 Main St, Austin, TX',
    lat: 30.27,
    lon: -97.74,
    ...overrides,
  };
}

export function makeAudit(overrides: Partial<Audit> = {}): Audit {
  return {
    businessId: 'osm-node-1',
    status: 'ok',
    requestedUrl: 'https://test-plumbing.example/',
    finalUrl: 'https://test-plumbing.example/',
    httpStatus: 200,
    https: true,
    httpsAvailable: true,
    redirected: false,
    responseTimeMs: 500,
    htmlBytes: 20_000,
    truncated: false,
    hasViewport: true,
    title: 'Test Plumbing',
    hasMetaDescription: true,
    hasChatWidget: true,
    chatVendor: 'tawk.to',
    hasContactForm: true,
    copyrightYear: 2026,
    error: null,
    ...overrides,
  };
}
