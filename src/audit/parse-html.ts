import { parse, type HTMLElement } from 'node-html-parser';

/** Signals extracted from a homepage. Pure: same HTML in -> same signals out. */
export interface HtmlSignals {
  readonly title: string | null;
  readonly hasViewport: boolean;
  readonly hasMetaDescription: boolean;
  readonly hasChatWidget: boolean;
  readonly chatVendor: string | null;
  readonly hasContactForm: boolean;
  readonly copyrightYear: number | null;
}

const CHAT_VENDORS: readonly (readonly [string, RegExp])[] = [
  ['tawk.to', /embed\.tawk\.to/i],
  ['intercom', /widget\.intercom\.io|intercomcdn\.com/i],
  ['drift', /js\.driftt\.com|drift\.com\/include/i],
  ['crisp', /client\.crisp\.chat/i],
  ['livechat', /cdn\.livechatinc\.com/i],
  ['zendesk', /static\.zdassets\.com|zopim\.com/i],
  ['hubspot', /js\.usemessages\.com|hs-scripts\.com/i],
  ['tidio', /code\.tidio\.co/i],
  ['olark', /static\.olark\.com/i],
  ['freshchat', /wchat\.freshchat\.com|freshchat\.com\/js/i],
  ['podium', /connect\.podium\.com|podium\.com\/widget/i],
  ['smartsupp', /smartsuppchat\.com/i],
  ['jivochat', /code\.jivosite\.com|jivochat/i],
  ['chatra', /call\.chatra\.io/i],
  ['facebook', /xfbml\.customerchat|fb-customerchat/i],
  ['chatbase', /chatbase\.co\/embed/i],
  ['botpress', /cdn\.botpress\.cloud/i],
  ['voiceflow', /cdn\.voiceflow\.com/i],
];

const GENERIC_CHAT = /\b(chat-widget|chatwidget|live-?chat|chatbot|chat-bubble)/i;
const FORM_EMBEDS = /jotform\.com|typeform\.com|docs\.google\.com\/forms|hsforms\.(com|net)|wufoo\.com|formstack\.com|cognitoforms\.com/i;
const CONTACT_FIELD_NAMES = /name|phone|email|message|comment|details|quote/i;

function metaContent(root: HTMLElement, name: string): string | null {
  const meta = root
    .querySelectorAll('meta')
    .find((m) => (m.getAttribute('name') ?? '').trim().toLowerCase() === name);
  return meta ? (meta.getAttribute('content') ?? '').trim() : null;
}

function detectChat(root: HTMLElement, html: string): string | null {
  const sources = root
    .querySelectorAll('script, iframe, link')
    .map((el) => `${el.getAttribute('src') ?? ''} ${el.getAttribute('href') ?? ''} ${el.tagName === 'SCRIPT' ? el.text : ''}`)
    .join('\n');
  const vendor = CHAT_VENDORS.find(([, re]) => re.test(sources));
  if (vendor) return vendor[0];
  const generic = root
    .querySelectorAll('[id], [class]')
    .some((el) => GENERIC_CHAT.test(`${el.getAttribute('id') ?? ''} ${el.getAttribute('class') ?? ''}`));
  if (generic) return 'unknown';
  return /<chat-widget\b/i.test(html) ? 'unknown' : null;
}

function isContactForm(form: HTMLElement): boolean {
  const role = (form.getAttribute('role') ?? '').toLowerCase();
  if (role === 'search') return false;
  if (form.querySelector('textarea')) return true;
  const inputs = form.querySelectorAll('input');
  const meaningful = inputs.filter((i) => {
    const type = (i.getAttribute('type') ?? 'text').toLowerCase();
    if (['hidden', 'search', 'submit', 'button', 'checkbox', 'radio'].includes(type)) return false;
    return type === 'email' || type === 'tel' || CONTACT_FIELD_NAMES.test(i.getAttribute('name') ?? '');
  });
  return meaningful.length > 0 || /contact|quote|estimate/i.test(form.getAttribute('action') ?? '');
}

function detectContactForm(root: HTMLElement): boolean {
  if (root.querySelectorAll('form').some(isContactForm)) return true;
  return root.querySelectorAll('iframe').some((f) => FORM_EMBEDS.test(f.getAttribute('src') ?? ''));
}

const COPYRIGHT_RE = /(?:©|\(c\)|copyright)[^\d<]{0,30}((?:19|20)\d{2})(?:\s*[-\u2013\u2014]\s*((?:19|20)\d{2}))?/gi;

function detectCopyrightYear(root: HTMLElement, nowYear: number): number | null {
  const footer = root.querySelector('footer, #footer, .footer, [role=contentinfo]');
  const scope = footer ?? root;
  scope.querySelectorAll('script, style').forEach((el) => el.remove());
  const text = scope.text.replace(/\s+/g, ' ');
  const years = [...text.matchAll(COPYRIGHT_RE)]
    .flatMap((m) => [m[1], m[2]])
    .filter((y): y is string => y !== undefined)
    .map(Number)
    .filter((y) => y >= 1990 && y <= nowYear + 1);
  return years.length > 0 ? Math.max(...years) : null;
}

export function parseHtmlSignals(html: string, nowYear: number): HtmlSignals {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true } });
  const rawTitle = root.querySelector('title')?.text.replace(/\s+/g, ' ').trim() ?? '';
  const viewport = metaContent(root, 'viewport');
  const description = metaContent(root, 'description');
  const chatVendor = detectChat(root, html);
  return {
    title: rawTitle ? rawTitle.slice(0, 200) : null,
    hasViewport: viewport !== null && /width\s*=/i.test(viewport),
    hasMetaDescription: description !== null && description.length > 0,
    hasChatWidget: chatVendor !== null,
    chatVendor,
    hasContactForm: detectContactForm(root),
    copyrightYear: detectCopyrightYear(root, nowYear),
  };
}
