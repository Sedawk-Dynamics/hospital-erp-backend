import { Router, type Request, type Response, type NextFunction } from 'express';
import { Readable } from 'stream';
import { createProxyMiddleware } from 'http-proxy-middleware';
import jwt from 'jsonwebtoken';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { prisma } from '../../../config/database';
import { authenticate } from '../../../middleware/authenticate';
import type { AuthenticatedRequest } from '../../../shared/types';

// ── PACS auth gateway ────────────────────────────────────────────────────────
// A tenant-scoped reverse proxy that lets browsers reach Orthanc's OHIF viewer
// and DICOMweb WITHOUT ever exposing Orthanc directly. Flow:
//
//   1. Frontend (Bearer-authed) calls POST /api/v1/pacs/session → we mint a
//      short-lived, tenant-scoped cookie (HttpOnly), signed with the app JWT
//      secret, scoped to the proxy path.
//   2. Frontend embeds the OHIF iframe at
//      <backend>/api/v1/pacs/o/ohif/viewer?StudyInstanceUIDs=<uid>. Because the
//      iframe loads from the backend origin, the cookie rides along on every
//      OHIF + DICOMweb sub-request automatically.
//   3. This proxy validates the cookie, ENFORCES that any requested study
//      belongs to the cookie's tenant, injects Orthanc's basic-auth, and
//      streams the response. Raw Orthanc admin REST is blocked.
//
// Orthanc's bundled OHIF uses relative asset + DICOMweb paths, so the only
// Orthanc-side config needed is RouterBasename = the proxy's /ohif/ path
// (set in docker-compose when PACS_PROXY_ENABLED).

const PROXY_MOUNT = '/pacs'; // mounted on apiRouter (/api/v1)
const PROXY_BASE_PATH = '/api/v1/pacs/o'; // browser-facing base for OHIF + DICOMweb
const COOKIE_NAME = 'pacs_session';

interface PacsSessionClaims {
  tid: string; // tenantId
  uid: string; // userId
  scope: 'pacs';
}

/** Browser-facing OHIF viewer base, e.g. http://localhost:4000/api/v1/pacs/o/ohif. */
export function pacsProxyOhifBase(): string {
  return `${env.PACS_PROXY_PUBLIC_URL.replace(/\/+$/, '')}${PROXY_BASE_PATH}/ohif`;
}

/** Build the proxied OHIF viewer URL for a study (used by the provider). */
export function buildProxiedViewerUrl(studyInstanceUid: string): string {
  return `${pacsProxyOhifBase()}/viewer?StudyInstanceUIDs=${encodeURIComponent(studyInstanceUid)}`;
}

/**
 * Relative URL the frontend stores on an attachment after the local copy is
 * dropped (PACS_DROP_LOCAL). resolveAttachmentUrl() appends the access token so
 * plain <a>/<img>/fetch can authenticate. Streams the raw .dcm from the PACS.
 */
export function buildRetrieveUrl(sopInstanceUid: string): string {
  return `/api/v1/pacs/file?sop=${encodeURIComponent(sopInstanceUid)}`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

/** Pull every StudyInstanceUID referenced by a DICOMweb sub-path + query. */
function referencedStudyUids(subPath: string, query: Request['query']): string[] {
  const uids = new Set<string>();
  // Path form: /dicom-web/studies/<uid>/...
  const m = subPath.match(/\/dicom-web\/studies\/([^/?]+)/);
  if (m && m[1]) uids.add(decodeURIComponent(m[1]));
  // QIDO query: ?StudyInstanceUID=<uid> (single or repeated)
  const qido = query.StudyInstanceUID;
  if (typeof qido === 'string') uids.add(qido);
  else if (Array.isArray(qido)) qido.forEach((v) => typeof v === 'string' && uids.add(v));
  // WADO-URI: ?studyUID=<uid>
  const wado = query.studyUID;
  if (typeof wado === 'string') uids.add(wado);
  return [...uids];
}

/** Cookie auth — validates the signed PACS session and attaches the tenant. */
function pacsCookieAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) {
    res.status(401).json({ success: false, message: 'PACS session required' });
    return;
  }
  try {
    const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as PacsSessionClaims;
    if (claims.scope !== 'pacs' || !claims.tid) throw new Error('bad scope');
    (req as any).pacsTenantId = claims.tid;
    next();
  } catch {
    res.status(401).json({ success: false, message: 'PACS session invalid or expired' });
  }
}

/** Only allow OHIF assets + tenant-owned DICOMweb; block raw Orthanc REST. */
async function enforceTenantScope(req: Request, res: Response, next: NextFunction) {
  const subPath = req.path; // already stripped of /api/v1/pacs/o by the mount

  if (subPath === '/' || subPath.startsWith('/ohif')) {
    next(); // OHIF SPA + static assets — not sensitive
    return;
  }
  if (!subPath.startsWith('/dicom-web')) {
    // Block /system, /studies, /instances, /tools, … (raw Orthanc admin API)
    res.status(403).json({ success: false, message: 'Path not permitted via PACS proxy' });
    return;
  }

  const tenantId = (req as any).pacsTenantId as string;
  const uids = referencedStudyUids(subPath, req.query);
  if (uids.length === 0) {
    // Bare study list / enumeration — deny; our flow always targets a study.
    res.status(403).json({ success: false, message: 'A specific study is required' });
    return;
  }
  try {
    const owned = await prisma.dicomStudy.count({
      where: { tenantId, studyInstanceUid: { in: uids } },
    });
    if (owned < uids.length) {
      res.status(403).json({ success: false, message: 'Study not in your tenant' });
      return;
    }
    next();
  } catch (err) {
    logger.error({ err }, 'PACS proxy scope check failed');
    res.status(500).json({ success: false, message: 'PACS scope check failed' });
  }
}

function orthancAuthHeader(): string | null {
  if (!env.ORTHANC_USERNAME) return null;
  return `Basic ${Buffer.from(`${env.ORTHANC_USERNAME}:${env.ORTHANC_PASSWORD}`).toString('base64')}`;
}

export function buildPacsRouter(): Router {
  const router = Router();

  // Is the archive answering? Any authenticated user may ask: the viewer needs
  // it to explain why a study will not open, and the radiology settings screen
  // needs it to show the department whether imaging is up. It reports only
  // reachability — no host, credentials or configuration detail.
  router.get('/health', authenticate, async (_req: Request, res: Response) => {
    const { getPacsHealth } = await import('./index');
    res.json({ success: true, data: await getPacsHealth() });
  });

  // Mint a tenant-scoped session cookie from the Bearer-authenticated user.
  router.post('/session', authenticate, (req: AuthenticatedRequest, res: Response) => {
    const ttlMin = env.PACS_SESSION_TTL_MIN;
    const token = jwt.sign(
      { tid: req.user!.tenantId, uid: req.user!.userId, scope: 'pacs' } as PacsSessionClaims,
      env.JWT_ACCESS_SECRET,
      { expiresIn: `${ttlMin}m` },
    );
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: env.PACS_COOKIE_SECURE,
      sameSite: env.PACS_COOKIE_SAMESITE,
      path: PROXY_BASE_PATH,
      maxAge: ttlMin * 60 * 1000,
    });
    res.json({ success: true, data: { viewerBase: pacsProxyOhifBase(), ttlMin } });
  });

  // Reverse proxy to Orthanc. Mounted at /o so req.url is stripped to the
  // Orthanc path (/ohif/... or /dicom-web/...) before forwarding.
  const proxy = createProxyMiddleware({
    target: env.ORTHANC_URL,
    changeOrigin: true,
    xfwd: true,
    on: {
      proxyReq: (proxyReq) => {
        const auth = orthancAuthHeader();
        if (auth) proxyReq.setHeader('Authorization', auth);
      },
      error: (err, _req, res) => {
        logger.error({ err }, 'PACS proxy upstream error');
        if (res && 'writeHead' in res && !res.headersSent) {
          (res as Response).status(502).json({ success: false, message: 'PACS upstream unavailable' });
        }
      },
    },
  });

  router.use('/o', pacsCookieAuth, enforceTenantScope, proxy);

  // Authenticated raw-DICOM retrieve. Used when PACS_DROP_LOCAL drops the local
  // /uploads copy: download + the in-house fallback viewer fetch the bytes back
  // from Orthanc. Auth via ?token= (app access JWT or pacs cookie) so plain
  // <a>/fetch work; tenant-scoped against our DicomInstance records.
  router.get('/file', async (req: Request, res: Response) => {
    const token = (req.query.token as string) || readCookie(req, COOKIE_NAME);
    const sop = req.query.sop as string;
    if (!token || !sop) {
      res.status(400).json({ success: false, message: 'token and sop are required' });
      return;
    }
    let tenantId: string;
    try {
      const claims = jwt.verify(token, env.JWT_ACCESS_SECRET) as Record<string, string>;
      tenantId = claims.tid ?? claims.tenantId;
      if (!tenantId) throw new Error('no tenant');
    } catch {
      res.status(401).json({ success: false, message: 'Invalid or expired token' });
      return;
    }
    try {
      const owned = await prisma.dicomInstance.findFirst({
        where: { tenantId, sopInstanceUid: sop },
        select: { id: true },
      });
      if (!owned) {
        res.status(403).json({ success: false, message: 'Instance not in your tenant' });
        return;
      }
      const auth = orthancAuthHeader();
      const headers: Record<string, string> = auth ? { Authorization: auth } : {};
      // Resolve the Orthanc internal id for this SOP Instance UID.
      const lookup = await fetch(`${env.ORTHANC_URL.replace(/\/+$/, '')}/tools/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', ...headers },
        body: sop,
      });
      if (!lookup.ok) throw new Error(`Orthanc lookup ${lookup.status}`);
      const hits = (await lookup.json()) as Array<{ Type: string; ID: string }>;
      const instance = hits.find((h) => h.Type === 'Instance');
      if (!instance) {
        res.status(404).json({ success: false, message: 'Instance not found in PACS' });
        return;
      }
      const file = await fetch(
        `${env.ORTHANC_URL.replace(/\/+$/, '')}/instances/${instance.ID}/file`,
        { headers },
      );
      if (!file.ok || !file.body) throw new Error(`Orthanc file ${file.status}`);
      res.setHeader('Content-Type', 'application/dicom');
      res.setHeader('Cache-Control', 'private, max-age=300');
      Readable.fromWeb(file.body as any).pipe(res);
    } catch (err) {
      logger.error({ err, sop }, 'PACS retrieve failed');
      if (!res.headersSent) res.status(502).json({ success: false, message: 'PACS retrieve failed' });
    }
  });

  return router;
}
