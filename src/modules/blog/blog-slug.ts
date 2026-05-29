/**
 * Derive a URL-safe slug from a free-text title. Lowercase, ASCII-fold
 * (best-effort via NFKD + diacritic strip), replace non-alphanumeric with `-`,
 * collapse repeats, trim leading/trailing dashes. Caller is responsible for
 * resolving collisions by suffixing `-2`, `-3`, ...
 */
export function slugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.length > 0 ? base.slice(0, 80) : 'post';
}

/**
 * YouTube/Vimeo whitelist + normalization. Returns the embed-form URL if
 * recognized, or null if the URL is not a supported provider. The DB column
 * stores the normalized form so the renderer is simple.
 */
export function normalizeVideoUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;

  // YouTube
  if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') {
    if (u.pathname.startsWith('/embed/')) {
      const id = u.pathname.slice('/embed/'.length);
      if (isYouTubeId(id)) return `https://www.youtube.com/embed/${id}`;
    }
    if (u.pathname === '/watch') {
      const id = u.searchParams.get('v');
      if (id && isYouTubeId(id)) return `https://www.youtube.com/embed/${id}`;
    }
  }
  if (u.hostname === 'youtu.be') {
    const id = u.pathname.replace(/^\//, '');
    if (isYouTubeId(id)) return `https://www.youtube.com/embed/${id}`;
  }

  // Vimeo
  if (u.hostname === 'player.vimeo.com' && u.pathname.startsWith('/video/')) {
    const id = u.pathname.slice('/video/'.length).replace(/\/$/, '');
    if (isVimeoId(id)) return `https://player.vimeo.com/video/${id}`;
  }
  if (u.hostname === 'vimeo.com' || u.hostname === 'www.vimeo.com') {
    const id = u.pathname.replace(/^\//, '').split('/')[0];
    if (isVimeoId(id)) return `https://player.vimeo.com/video/${id}`;
  }

  return null;
}

function isYouTubeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{6,15}$/.test(id);
}

function isVimeoId(id: string): boolean {
  return /^[0-9]{5,15}$/.test(id);
}
