import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { AppError } from '../../shared/appError';
import { writeAudit } from '../../shared/audit';
import {
  credentialKeyInfo,
  decryptCredentials,
  encryptCredentials,
  getEInvoiceProviderInfo,
  irnCancelWindowHours,
  maskUsername,
  resolveEInvoiceProvider,
  CredentialCryptoError,
  EINVOICE_SANDBOX_LABEL,
  GST_PORTALS,
  type CredentialKeyInfo,
  type EInvoiceProviderInfo,
  type GstPortal,
  type PortalCredentials,
} from '../../services/einvoice';

// ---------------------------------------------------------------------------
// G-5 (gap #266): the hospital's e-invoice and e-way bill portal logins, and
// whether each integration is READY.
//
// "Ready" is the one fact the GST settings switches hang on: a provider is
// configured on the server AND this hospital's login for that portal is saved
// and readable. Until both hold, the switch reads "Not available" and the
// server refuses to turn it on — a switch that says e-invoicing is live when
// nothing can generate an IRN is the bug this item is about.
//
// Secrets never leave this file in plain text except to the provider adapter:
// the browser gets a masked username and set/not-set flags.
// ---------------------------------------------------------------------------

export const PORTAL_AUDIT_ENTITY = 'gst_portal_credentials';

const PORTAL_LABEL: Record<GstPortal, string> = { einvoice: 'E-invoice (IRP)', eway: 'E-way bill' };

interface StoredSecret {
  username: string;
  password: string;
  clientId: string | null;
  clientSecret: string | null;
}

const aadFor = (tenantId: string, portal: GstPortal) => `gst-portal:${tenantId}:${portal}`;

export function isGstPortal(v: unknown): v is GstPortal {
  return typeof v === 'string' && (GST_PORTALS as readonly string[]).includes(v);
}

type Row = {
  secretCipher: string;
  usernameHint: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestProvider: string | null;
  updatedAt: Date;
};

/** `undefined` when the table cannot be read (e.g. not yet created) — treated as "not set". */
async function readRow(tenantId: string, portal: GstPortal): Promise<Row | null | undefined> {
  try {
    return (await prisma.gstPortalCredential.findUnique({
      where: { tenantId_portal: { tenantId, portal } },
    })) as Row | null;
  } catch (err) {
    logger.warn({ err, tenantId, portal }, 'Could not read the GST portal credentials');
    return undefined;
  }
}

export interface PortalReadiness {
  portal: GstPortal;
  label: string;
  ready: boolean;
  /** Why it is not ready, in words for the settings screen. */
  reason: string | null;
  provider: EInvoiceProviderInfo;
  credentials: {
    set: boolean;
    /** Whether the stored secret decrypts with the server's current key. */
    readable: boolean;
    usernameHint: string | null;
    passwordSet: boolean;
    clientIdSet: boolean;
    clientSecretSet: boolean;
    updatedAt: string | null;
    problem: string | null;
  };
  lastTest: { at: string; ok: boolean; message: string | null; provider: string | null } | null;
}

export async function getPortalReadiness(
  tenantId: string,
  portal: GstPortal,
  env: Record<string, string | undefined> = process.env,
): Promise<PortalReadiness> {
  const provider = getEInvoiceProviderInfo(env);
  const row = await readRow(tenantId, portal);
  let secret: StoredSecret | null = null;
  let problem: string | null = row === undefined ? 'The saved credentials could not be read' : null;
  if (row) {
    try {
      secret = decryptCredentials<StoredSecret>(row.secretCipher, aadFor(tenantId, portal), env);
    } catch (err) {
      problem = err instanceof CredentialCryptoError ? err.message : 'The saved credentials could not be read';
    }
  }
  const set = !!row;
  const readable = !!secret?.username && !!secret?.password;

  const reason = !provider.configured
    ? provider.reason ?? 'No e-invoice / e-way bill provider is configured on this server'
    : !set
      ? `${PORTAL_LABEL[portal]} portal credentials have not been saved in GST settings`
      : !readable
        ? problem ?? 'The saved credentials are incomplete — enter them again'
        : null;

  return {
    portal,
    label: PORTAL_LABEL[portal],
    ready: reason === null,
    reason,
    provider,
    credentials: {
      set,
      readable,
      usernameHint: row?.usernameHint ?? null,
      passwordSet: !!secret?.password,
      clientIdSet: !!secret?.clientId,
      clientSecretSet: !!secret?.clientSecret,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
      problem,
    },
    lastTest:
      row?.lastTestAt && row.lastTestOk != null
        ? {
            at: row.lastTestAt.toISOString(),
            ok: row.lastTestOk,
            message: row.lastTestMessage,
            provider: row.lastTestProvider,
          }
        : null,
  };
}

export interface PortalStatus {
  provider: EInvoiceProviderInfo;
  sandboxLabel: string;
  encryption: CredentialKeyInfo;
  cancelWindowHours: number;
  einvoice: PortalReadiness;
  eway: PortalReadiness;
}

export async function getPortalStatus(tenantId: string): Promise<PortalStatus> {
  const [einvoice, eway] = await Promise.all([
    getPortalReadiness(tenantId, 'einvoice'),
    getPortalReadiness(tenantId, 'eway'),
  ]);
  return {
    provider: getEInvoiceProviderInfo(),
    sandboxLabel: EINVOICE_SANDBOX_LABEL,
    encryption: credentialKeyInfo(),
    cancelWindowHours: irnCancelWindowHours(),
    einvoice,
    eway,
  };
}

const clean = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  if (typeof v !== 'string') throw AppError.badRequest('Credentials must be text');
  const t = v.trim();
  if (t.length > max) throw AppError.badRequest(`A credential is longer than ${max} characters`);
  return t || null;
};

/**
 * Save (or update) one portal's login. A blank password / client secret on an
 * update keeps the stored one, so the admin can correct the username without
 * re-typing secrets they cannot see.
 */
export async function savePortalCredentials(
  tenantId: string,
  userId: string,
  portal: GstPortal,
  input: Record<string, unknown>,
): Promise<PortalReadiness> {
  const key = credentialKeyInfo();
  if (!key.available) {
    throw new AppError(
      `Portal credentials cannot be stored: ${key.reason ?? 'no encryption key'}`,
      503,
      'GST_PORTAL_KEY_MISSING',
    );
  }
  const username = clean(input.username, 100);
  const password = clean(input.password, 200);
  const clientId = clean(input.clientId, 200);
  const clientSecret = clean(input.clientSecret, 300);
  const clearClientSecret = input.clearClientSecret === true;

  let existing: StoredSecret | null = null;
  const row = await readRow(tenantId, portal);
  if (row) {
    try {
      existing = decryptCredentials<StoredSecret>(row.secretCipher, aadFor(tenantId, portal));
    } catch {
      existing = null; // unreadable — the admin must re-enter everything
    }
  }

  const merged: StoredSecret = {
    username: username ?? existing?.username ?? '',
    password: password ?? existing?.password ?? '',
    clientId: 'clientId' in input ? clientId : existing?.clientId ?? null,
    clientSecret: clearClientSecret ? null : clientSecret ?? existing?.clientSecret ?? null,
  };
  if (!merged.username) throw AppError.badRequest('Username is required');
  if (!merged.password) throw AppError.badRequest('Password is required');

  const secretCipher = encryptCredentials(merged, aadFor(tenantId, portal));
  const usernameHint = maskUsername(merged.username);
  // A changed login has not been tested; an old "connected" must not vouch for it.
  const data = {
    secretCipher,
    usernameHint,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastTestProvider: null,
    updatedBy: userId,
  };
  await prisma.gstPortalCredential.upsert({
    where: { tenantId_portal: { tenantId, portal } },
    create: { tenantId, portal, ...data },
    update: data,
  });

  await writeAudit({
    tenantId,
    userId,
    action: row ? 'update' : 'create',
    entityType: PORTAL_AUDIT_ENTITY,
    entityId: `${tenantId}:${portal}`,
    description: `${PORTAL_LABEL[portal]} portal credentials ${row ? 'updated' : 'saved'} (username ${usernameHint})`,
    // Flags only — never a secret.
    newValues: {
      portal,
      usernameHint,
      passwordChanged: !!password,
      clientIdSet: !!merged.clientId,
      clientSecretSet: !!merged.clientSecret,
    },
  });
  return getPortalReadiness(tenantId, portal);
}

export async function deletePortalCredentials(tenantId: string, userId: string, portal: GstPortal) {
  await prisma.gstPortalCredential.deleteMany({ where: { tenantId, portal } });
  await writeAudit({
    tenantId,
    userId,
    action: 'delete',
    entityType: PORTAL_AUDIT_ENTITY,
    entityId: `${tenantId}:${portal}`,
    description: `${PORTAL_LABEL[portal]} portal credentials removed`,
    newValues: { portal },
  });
  return getPortalReadiness(tenantId, portal);
}

/** The decrypted login for the adapter. Throws a 409 when it is not usable. */
export async function loadPortalCredentials(
  tenantId: string,
  portal: GstPortal,
  gstin: string | null,
): Promise<PortalCredentials> {
  const row = await readRow(tenantId, portal);
  if (!row) {
    throw AppError.conflict(`${PORTAL_LABEL[portal]} portal credentials have not been saved in GST settings`, 'GST_PORTAL_NOT_READY');
  }
  let s: StoredSecret;
  try {
    s = decryptCredentials<StoredSecret>(row.secretCipher, aadFor(tenantId, portal));
  } catch (err) {
    throw AppError.conflict(
      err instanceof CredentialCryptoError ? err.message : 'The saved portal credentials could not be read',
      'GST_PORTAL_NOT_READY',
    );
  }
  return { username: s.username, password: s.password, clientId: s.clientId, clientSecret: s.clientSecret, gstin };
}

/** Test connection: log in to the portal with the SAVED credentials and record the answer. */
export async function testPortalConnection(tenantId: string, userId: string, portal: GstPortal) {
  const { provider, info } = resolveEInvoiceProvider();
  if (!provider) {
    throw new AppError(info.reason ?? 'No e-invoice provider configured', 503, 'EINVOICE_NOT_CONFIGURED');
  }
  const { getGstProfile } = await import('../hospital-settings/hospital-settings.service');
  const profile = await getGstProfile(tenantId);
  const creds = await loadPortalCredentials(tenantId, portal, profile.gstin);

  let ok = false;
  let message: string;
  try {
    const r = await provider.testConnection(portal, creds);
    ok = r.ok;
    message = r.message;
  } catch {
    message = 'Test failed: unexpected error talking to the provider';
  }
  const at = new Date();
  try {
    await prisma.gstPortalCredential.update({
      where: { tenantId_portal: { tenantId, portal } },
      data: {
        lastTestAt: at,
        lastTestOk: ok,
        lastTestMessage: message.slice(0, 500),
        lastTestProvider: provider.name.slice(0, 60),
      },
    });
  } catch (err) {
    logger.warn({ err, tenantId, portal }, 'Could not record the GST portal connection test');
  }
  await writeAudit({
    tenantId,
    userId,
    action: 'update',
    entityType: PORTAL_AUDIT_ENTITY,
    entityId: `${tenantId}:${portal}`,
    description: `${PORTAL_LABEL[portal]} portal connection test via ${provider.name}${provider.sandbox ? ` (${EINVOICE_SANDBOX_LABEL})` : ''}: ${ok ? 'connected' : 'failed'} — ${message}`,
    newValues: { portal, ok, provider: provider.name, sandbox: provider.sandbox },
  });
  return { ok, message, testedAt: at.toISOString(), provider: provider.name, sandbox: provider.sandbox };
}
