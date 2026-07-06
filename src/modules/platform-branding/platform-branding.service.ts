import path from 'path';
import fs from 'fs';
import { logger } from '../../config/logger';
import { getFileUrl, deleteFile } from '../../services/upload.service';

// ============================================================================
// Platform branding — the super-admin's platform logo, in TWO placement
// variants:
//   - logoLightUrl : the logo meant to sit on LIGHT-coloured surfaces
//                    (login screen, sidebars, website navbar).
//   - logoDarkUrl  : the logo meant to sit on DARK-coloured surfaces
//                    (e.g. the website footer). NOTE: this is about the
//                    background the logo is placed ON, not an app theme toggle.
//
// This is a genuinely global, single-row setting. Rather than add a Prisma
// model (and take the Windows prisma-generate engine-lock hit / a migration),
// we persist the two URLs in a small JSON file next to the app. The uploaded
// image files themselves live in the normal /uploads store and are served
// statically & publicly, exactly like lab/imaging attachments.
// ============================================================================

export type LogoVariant = 'light' | 'dark';

export interface PlatformBranding {
  /** logo for light backgrounds (public /uploads URL) or null */
  logoLightUrl: string | null;
  /** logo for dark backgrounds (public /uploads URL) or null */
  logoDarkUrl: string | null;
  updatedAt: string | null;
}

const DATA_DIR = path.resolve(process.cwd(), 'platform-config');
const DATA_FILE = path.join(DATA_DIR, 'branding.json');

const EMPTY: PlatformBranding = { logoLightUrl: null, logoDarkUrl: null, updatedAt: null };

function read(): PlatformBranding {
  try {
    if (!fs.existsSync(DATA_FILE)) return { ...EMPTY };
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return {
      logoLightUrl: typeof parsed.logoLightUrl === 'string' ? parsed.logoLightUrl : null,
      logoDarkUrl: typeof parsed.logoDarkUrl === 'string' ? parsed.logoDarkUrl : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read platform branding file; returning empty');
    return { ...EMPTY };
  }
}

function write(b: PlatformBranding): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(b, null, 2), 'utf8');
}

const keyFor = (v: LogoVariant): 'logoLightUrl' | 'logoDarkUrl' =>
  v === 'dark' ? 'logoDarkUrl' : 'logoLightUrl';

/** Public read — the two logo URLs (or nulls). */
export function getBranding(): PlatformBranding {
  return read();
}

/** Replace one variant's logo with a freshly-uploaded file; removes the old file. */
export function setLogo(variant: LogoVariant, filename: string): PlatformBranding {
  const branding = read();
  const key = keyFor(variant);
  const previous = branding[key];
  if (previous && previous.startsWith('/uploads/')) {
    void deleteFile(path.basename(previous));
  }
  branding[key] = getFileUrl(filename);
  branding.updatedAt = new Date().toISOString();
  write(branding);
  return branding;
}

/** Clear one variant back to the built-in icon fallback; removes the file. */
export function clearLogo(variant: LogoVariant): PlatformBranding {
  const branding = read();
  const key = keyFor(variant);
  const previous = branding[key];
  if (previous && previous.startsWith('/uploads/')) {
    void deleteFile(path.basename(previous));
  }
  branding[key] = null;
  branding.updatedAt = new Date().toISOString();
  write(branding);
  return branding;
}
