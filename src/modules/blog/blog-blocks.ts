import { BadRequestException } from '@nestjs/common';

/**
 * Blog body is a list of typed content blocks. Each block is rendered
 * independently on the frontend; adding a new content type means adding a
 * new branch to the union, a validator case here, and a renderer there.
 *
 * Inline formatting inside text fields is intentionally NOT supported —
 * paragraph/quote/list items are plain text. If we want bold/italic/links
 * later we'd either add an inline-mark vocabulary or swap to a richer
 * format like ProseMirror JSON.
 *
 * Image refs (`{ ref: 0 }`) are accepted in the *input* shape — they point
 * at the i-th file in the `media` multipart field of the same request — and
 * resolved to full URLs by `validateAndNormalizeBody` before persistence.
 * The persisted (and DTO-returned) shape only ever has `url`.
 */
export type BlogBlock =
  | BlogParagraphBlock
  | BlogImageBlock
  | BlogQuoteBlock
  | BlogListBlock;

export interface BlogParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface BlogImageItem {
  url: string;
  alt: string | null;
  caption: string | null;
}

export interface BlogImageBlock {
  type: 'image';
  images: BlogImageItem[];
}

export interface BlogQuoteBlock {
  type: 'quote';
  text: string;
  attribution: string | null;
}

export interface BlogListBlock {
  type: 'list';
  style: 'bulleted' | 'numbered';
  items: string[];
}

const MAX_BLOCKS = 100;

const LIMITS = {
  paragraphText: 5000,
  quoteText: 2000,
  quoteAttribution: 200,
  imagesPerBlock: 12,
  imageAlt: 200,
  imageCaption: 500,
  listItems: 50,
  listItemLength: 500,
} as const;

/**
 * Validate + normalize a raw body. Throws BadRequestException on the first
 * invalid block.
 *
 * Image items may arrive in one of two shapes:
 *  - `{ url: '...' }` — an existing URL (must satisfy `isOwnBucketUrl`),
 *     typically used when patching to keep an image that's already there.
 *  - `{ ref: N }` — index into `uploadedUrls`, used for newly uploaded media
 *     sent in the same multipart request. Resolved to a URL here.
 *
 * Returns the canonical form (whitespace trimmed, optional fields
 * normalized to `null`, no extra keys) safe to persist as `jsonb`.
 */
export function validateAndNormalizeBody(
  raw: unknown,
  uploadedUrls: string[],
  isOwnBucketUrl: (url: string) => boolean,
): BlogBlock[] {
  if (!Array.isArray(raw)) {
    throw new BadRequestException('body must be an array of blocks');
  }
  if (raw.length === 0) {
    throw new BadRequestException('body must contain at least one block');
  }
  if (raw.length > MAX_BLOCKS) {
    throw new BadRequestException(`body cannot exceed ${MAX_BLOCKS} blocks`);
  }
  const refsUsed = new Set<number>();
  const blocks = raw.map((b, i) =>
    normalizeBlock(b, i, uploadedUrls, isOwnBucketUrl, refsUsed),
  );
  // Soft check — uploaded but unused media is wasteful but not fatal.
  // We don't throw; the orphan-cleanup pass in the service will catch it.
  return blocks;
}

function normalizeBlock(
  block: unknown,
  index: number,
  uploadedUrls: string[],
  isOwnBucketUrl: (url: string) => boolean,
  refsUsed: Set<number>,
): BlogBlock {
  if (!block || typeof block !== 'object') {
    throw new BadRequestException(`block ${index} must be an object`);
  }
  const b = block as Record<string, unknown>;
  switch (b.type) {
    case 'paragraph':
      return normalizeParagraph(b, index);
    case 'image':
      return normalizeImage(b, index, uploadedUrls, isOwnBucketUrl, refsUsed);
    case 'quote':
      return normalizeQuote(b, index);
    case 'list':
      return normalizeList(b, index);
    default:
      throw new BadRequestException(
        `block ${index} has unknown type: ${String(b.type)}`,
      );
  }
}

function normalizeParagraph(
  b: Record<string, unknown>,
  index: number,
): BlogParagraphBlock {
  const text = requireString(b.text, `block ${index}.text`, 1, LIMITS.paragraphText);
  return { type: 'paragraph', text };
}

function normalizeImage(
  b: Record<string, unknown>,
  index: number,
  uploadedUrls: string[],
  isOwnBucketUrl: (url: string) => boolean,
  refsUsed: Set<number>,
): BlogImageBlock {
  if (!Array.isArray(b.images) || b.images.length === 0) {
    throw new BadRequestException(`block ${index}.images must be a non-empty array`);
  }
  if (b.images.length > LIMITS.imagesPerBlock) {
    throw new BadRequestException(
      `block ${index}.images cannot exceed ${LIMITS.imagesPerBlock}`,
    );
  }
  const images: BlogImageItem[] = b.images.map((img, j) => {
    if (!img || typeof img !== 'object') {
      throw new BadRequestException(`block ${index}.images[${j}] must be an object`);
    }
    const item = img as Record<string, unknown>;
    const url = resolveImageUrl(
      item,
      `block ${index}.images[${j}]`,
      uploadedUrls,
      isOwnBucketUrl,
      refsUsed,
    );
    return {
      url,
      alt: optionalString(item.alt, `block ${index}.images[${j}].alt`, LIMITS.imageAlt),
      caption: optionalString(
        item.caption,
        `block ${index}.images[${j}].caption`,
        LIMITS.imageCaption,
      ),
    };
  });
  return { type: 'image', images };
}

function resolveImageUrl(
  item: Record<string, unknown>,
  path: string,
  uploadedUrls: string[],
  isOwnBucketUrl: (url: string) => boolean,
  refsUsed: Set<number>,
): string {
  const hasUrl = typeof item.url === 'string' && item.url.length > 0;
  const hasRef = item.ref !== undefined && item.ref !== null;
  if (hasUrl && hasRef) {
    throw new BadRequestException(`${path} cannot set both url and ref`);
  }
  if (hasUrl) {
    const url = requireString(item.url, `${path}.url`, 1, 2048);
    if (!isOwnBucketUrl(url)) {
      throw new BadRequestException(
        `${path}.url must point to the blog media bucket`,
      );
    }
    return url;
  }
  if (hasRef) {
    if (typeof item.ref !== 'number' || !Number.isInteger(item.ref) || item.ref < 0) {
      throw new BadRequestException(`${path}.ref must be a non-negative integer`);
    }
    if (item.ref >= uploadedUrls.length) {
      throw new BadRequestException(
        `${path}.ref=${item.ref} has no matching file in the media field`,
      );
    }
    refsUsed.add(item.ref);
    return uploadedUrls[item.ref];
  }
  throw new BadRequestException(`${path} must have either url or ref`);
}

function normalizeQuote(
  b: Record<string, unknown>,
  index: number,
): BlogQuoteBlock {
  const text = requireString(b.text, `block ${index}.text`, 1, LIMITS.quoteText);
  const attribution = optionalString(
    b.attribution,
    `block ${index}.attribution`,
    LIMITS.quoteAttribution,
  );
  return { type: 'quote', text, attribution };
}

function normalizeList(
  b: Record<string, unknown>,
  index: number,
): BlogListBlock {
  if (b.style !== 'bulleted' && b.style !== 'numbered') {
    throw new BadRequestException(
      `block ${index}.style must be 'bulleted' or 'numbered'`,
    );
  }
  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new BadRequestException(`block ${index}.items must be a non-empty array`);
  }
  if (b.items.length > LIMITS.listItems) {
    throw new BadRequestException(
      `block ${index}.items cannot exceed ${LIMITS.listItems}`,
    );
  }
  const items = b.items.map((item, j) =>
    requireString(
      item,
      `block ${index}.items[${j}]`,
      1,
      LIMITS.listItemLength,
    ),
  );
  return { type: 'list', style: b.style, items };
}

function requireString(
  value: unknown,
  path: string,
  min: number,
  max: number,
): string {
  if (typeof value !== 'string') {
    throw new BadRequestException(`${path} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    throw new BadRequestException(`${path} must be at least ${min} characters`);
  }
  if (trimmed.length > max) {
    throw new BadRequestException(`${path} cannot exceed ${max} characters`);
  }
  return trimmed;
}

function optionalString(
  value: unknown,
  path: string,
  max: number,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BadRequestException(`${path} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) {
    throw new BadRequestException(`${path} cannot exceed ${max} characters`);
  }
  return trimmed;
}

/**
 * Pull the first paragraph block's text and clamp to `maxLen` chars, with an
 * ellipsis if truncated. Used to auto-derive the excerpt when the editor
 * doesn't provide one.
 */
export function deriveExcerpt(blocks: BlogBlock[], maxLen = 280): string {
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'quote') {
      const text = b.text.replace(/\s+/g, ' ').trim();
      if (text.length === 0) continue;
      if (text.length <= maxLen) return text;
      return text.slice(0, maxLen - 1).trimEnd() + '…';
    }
  }
  return '';
}

/**
 * Walk the body and return every image URL in document order. Used by the
 * patch path to figure out which old storage blobs are now orphaned and
 * eligible for best-effort deletion.
 */
export function imageUrlsIn(blocks: BlogBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === 'image') {
      for (const img of b.images) out.push(img.url);
    }
  }
  return out;
}
