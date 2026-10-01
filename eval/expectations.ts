import type { AuditStatus, FindingId } from '../src/schemas.ts';

/** Known properties of the 8 fictional eval businesses (fixtures/eval + fixtures/sites). */
export interface Expectation {
  readonly id: string;
  readonly name: string;
  readonly status: AuditStatus;
  readonly mustHave: readonly FindingId[];
  readonly mustNotHave: readonly FindingId[];
}

export const EXPECTATIONS: readonly Expectation[] = Object.freeze([
  { id: 'osm-node-1001', name: 'Lone Star Plumbing', status: 'ok', mustHave: ['no_https', 'not_mobile_friendly', 'slow_response', 'outdated_copyright'], mustNotHave: ['no_website'] },
  { id: 'osm-node-1002', name: 'Barton Creek Plumbing', status: 'no_website', mustHave: ['no_website'], mustNotHave: [] },
  { id: 'osm-node-1003', name: 'Eastside Drain Pros', status: 'no_website', mustHave: ['no_website'], mustNotHave: [] },
  { id: 'osm-way-2004', name: 'Capitol Rooter', status: 'ok', mustHave: ['no_chat_widget'], mustNotHave: ['no_https', 'not_mobile_friendly', 'no_contact_form', 'outdated_copyright'] },
  { id: 'osm-node-1005', name: 'Hill Country Pipes', status: 'ok', mustHave: [], mustNotHave: ['no_chat_widget', 'no_https', 'no_https_redirect', 'not_mobile_friendly'] },
  { id: 'osm-node-1006', name: 'Austin Leak Fix', status: 'ok', mustHave: ['not_mobile_friendly', 'no_contact_form', 'outdated_copyright'], mustNotHave: ['no_https', 'slow_response'] },
  { id: 'osm-node-1007', name: 'Mueller Plumbing Co.', status: 'ok', mustHave: ['no_https_redirect', 'slow_response', 'outdated_copyright'], mustNotHave: ['no_https', 'no_contact_form'] },
  { id: 'osm-node-1008', name: 'Riverside Plumbing', status: 'robots_disallowed', mustHave: [], mustNotHave: ['no_https', 'not_mobile_friendly', 'no_chat_widget'] },
]);

export const EXPECTED_TOP3: readonly string[] = Object.freeze(['osm-node-1001', 'osm-node-1002', 'osm-node-1003']);
