/**
 * Canonical ConqrSuite identity: `person_uid` and `org_uid`.
 *
 * Cross-product calls cannot pass a ConqrHub row id and hope the other product
 * recognises it — the products do not share a database and their local ids are
 * unrelated. Delegation therefore travels on two canonical identifiers that
 * every product can map to its own local objects:
 *
 *   person_uid   an immutable human identity, stable for the life of the person
 *   org_uid      an immutable tenant identity
 *
 * Both are derived deterministically from ConqrHub's own primary keys, which
 * are UUIDs and never reused or rewritten. That gives immutability without a
 * new allocation service or a second identity store: an email address or a
 * display name would not, because both change.
 *
 * The shape is deliberately URN-like and namespaced so an identifier is
 * self-describing in a log line and cannot be confused with a bare row id:
 *
 *   conqr:person:9f1c...      conqr:org:4ab2...
 *
 * ConqrPlan maps these to its local `User` and `Workspace` through an explicit
 * identity table. Nothing is inferred from an email match — an unmapped
 * identity fails closed rather than guessing at a person.
 */

const PERSON_PREFIX = 'conqr:person:';
const ORG_PREFIX = 'conqr:org:';

/** Accepts the id shapes ConqrHub actually issues (UUID) plus test fixtures. */
const ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function toPersonUid(hubUserId: string): string {
  const id = String(hubUserId ?? '').trim();
  if (!ID_RE.test(id)) throw new Error('Invalid ConqrHub user id for person_uid');
  return `${PERSON_PREFIX}${id}`;
}

export function toOrgUid(hubWorkspaceId: string): string {
  const id = String(hubWorkspaceId ?? '').trim();
  if (!ID_RE.test(id)) throw new Error('Invalid ConqrHub workspace id for org_uid');
  return `${ORG_PREFIX}${id}`;
}

export function isPersonUid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(PERSON_PREFIX) &&
    ID_RE.test(value.slice(PERSON_PREFIX.length))
  );
}

export function isOrgUid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(ORG_PREFIX) &&
    ID_RE.test(value.slice(ORG_PREFIX.length))
  );
}

/**
 * The ConqrHub id inside a canonical uid.
 *
 * Only ConqrHub may do this. Another product resolving a canonical uid by
 * pulling the raw id out of it would be assuming ConqrHub's id space is
 * meaningful in its own database, which is exactly the coupling these
 * identifiers exist to prevent.
 */
export function hubIdFromPersonUid(personUid: string): string {
  if (!isPersonUid(personUid)) throw new Error('Not a person_uid');
  return personUid.slice(PERSON_PREFIX.length);
}

export function hubIdFromOrgUid(orgUid: string): string {
  if (!isOrgUid(orgUid)) throw new Error('Not an org_uid');
  return orgUid.slice(ORG_PREFIX.length);
}
