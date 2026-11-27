// Gap 295: the same claim alert sat in the bell 22 times (the reminder job ran
// on every server start and wrote a fresh row each time). New writes are now
// idempotent per event + record + user + reminder stage, and the rows already
// on file are collapsed here at read time — nothing is deleted from the table.

export interface NotificationKeyFields {
  id: string;
  referenceType: string | null;
  referenceId: string | null;
  title: string;
}

/**
 * Claim-deadline alerts ("expiring in 7 / 3 / 1 days", "due today", "expired")
 * are shown as one running entry per claim. Their wording is rebuilt from the
 * due date when shown, so every stage of an expired claim would otherwise read
 * "expired" and appear as several identical rows. Each stage is still written
 * once (insurance-expiry job); the newest unread stage resurfaces the entry.
 */
const CLAIM_DEADLINE_TITLE = /^Insurance claim (expiring in \d+ days?|due today|expired)$/i;

export function isClaimDeadlineNotification(n: { referenceType: string | null; title: string }): boolean {
  return n.referenceType === 'insurance_claim' && CLAIM_DEADLINE_TITLE.test(n.title.trim());
}

/** Rows with the same key are the same notification for the same user. */
export function notificationGroupKey(n: NotificationKeyFields): string {
  // Without a record there is nothing to say two rows are the same event.
  if (!n.referenceId) return `id:${n.id}`;
  const ref = `${n.referenceType ?? ''}:${n.referenceId}`;
  if (isClaimDeadlineNotification(n)) return `${ref}:claim_deadline`;
  return `${ref}:${n.title.trim().toLowerCase()}`;
}

export interface NotificationGroup<T> {
  /** Newest row of the group — the one shown. */
  head: T;
  memberIds: string[];
  unread: boolean;
}

/** Collapse rows (newest first) into groups, keeping first-seen order. */
export function collapseNotifications<T extends NotificationKeyFields & { isRead: boolean }>(
  rows: T[],
): NotificationGroup<T>[] {
  const groups = new Map<string, NotificationGroup<T>>();
  for (const row of rows) {
    const key = notificationGroupKey(row);
    const g = groups.get(key);
    if (g) {
      g.memberIds.push(row.id);
      if (!row.isRead) g.unread = true;
    } else {
      groups.set(key, { head: row, memberIds: [row.id], unread: !row.isRead });
    }
  }
  return Array.from(groups.values());
}

/** Number of distinct notifications among rows — what the bell badge shows. */
export function countUniqueNotifications(rows: NotificationKeyFields[]): number {
  return new Set(rows.map(notificationGroupKey)).size;
}

// ------------------------------------------------------------
// Write-time idempotency key (gap 295)
// ------------------------------------------------------------

export interface NotificationDedupeInput {
  notificationType: string;
  title: string;
  referenceType?: string | null;
  referenceId?: string | null;
  /**
   * The event, when the caller names it ("claim_deadline", "policy_expiry").
   * Defaults to the title — two notifications about one record with different
   * titles ("Claim approved", "Claim settled") are different events.
   */
  eventKey?: string | null;
  /** Reminder stage ("7d", "3d", "expired"); one row per stage. */
  reminderStage?: string | null;
}

const DEDUPE_KEY_MAX = 255;

function keyPart(value: string | null | undefined): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\|/g, '/');
}

/** Short, stable, dependency-free hash for an over-long key part (FNV-1a, 2 × 32 bit). */
function shortHash(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * The idempotency key stored in `notifications.dedupe_key`, unique together
 * with (tenant, recipient). Same event + type + record + stage → same key, so
 * a repeated or simultaneous write lands on the one row.
 *
 * Null when there is no reference record: nothing then says two writes are the
 * same event (the read-time collapse above follows the same rule).
 */
export function notificationDedupeKey(n: NotificationDedupeInput): string | null {
  if (!n.referenceId) return null;
  const event = keyPart(n.eventKey) || keyPart(n.title);
  const head = ['v1', keyPart(n.notificationType), keyPart(n.referenceType), keyPart(n.referenceId)].join('|');
  const tail = keyPart(n.reminderStage);
  const key = `${head}|${event}|${tail}`;
  if (key.length <= DEDUPE_KEY_MAX) return key;
  // Keep it inside the column: the event text is what can run long.
  const hashed = `${head}|#${shortHash(event)}|${tail}`;
  return hashed.length <= DEDUPE_KEY_MAX ? hashed : `v1|#${shortHash(key)}`;
}
