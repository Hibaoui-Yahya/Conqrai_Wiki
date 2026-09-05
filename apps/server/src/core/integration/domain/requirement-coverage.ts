import { PresentationModel, ResolutionState } from './presentation.types';

/**
 * Requirement coverage as the Related Work panel needs it.
 *
 * Coverage answers "does execution exist for this requirement", and the honest
 * answer depends on who is asking. A viewer who cannot see the linked work
 * cannot verify that it covers anything, so telling them "covered" would be
 * asking them to take an invisible item on trust. Telling them "uncovered"
 * would be a lie in the other direction, and could send them off to create
 * duplicate work.
 *
 * The resolution is a third state — **uncovered for you** — which says exactly
 * what is true: links exist, and you cannot verify any of them. It leaks
 * nothing: not the title, not the project, not the count, not even whether
 * there is one item or ten.
 *
 * > **Contradiction with the phase brief, recorded rather than papered over.**
 * > The brief describes this as an *existing* coverage contract with fields
 * > `total`, `approvedOrBeyond`, `covered`, `uncovered`, `provisional`,
 * > `unresolvedSources[]` and `gaps[]`. Only `total` and `gaps[]` existed, on
 * > `RequirementService.coverageGaps`; `approvedOrBeyond` existed only as the
 * > `APPROVED_OR_BEYOND` lifecycle constant, and `provisional`,
 * > `unresolvedSources` and `all_restricted` did not exist anywhere in either
 * > repository. The contract is defined here to the shape the brief specifies.
 */

/** Per-requirement coverage verdict, from this viewer's perspective. */
export enum CoverageState {
  /** No delivery link at all. */
  Uncovered = 'uncovered',
  /** At least one link resolves live and is verifiable by this viewer. */
  Covered = 'covered',
  /**
   * Links exist and resolve, but not to something that confirms delivery —
   * a deleted item, or a source we could not reach. Visually distinct from
   * covered because the requirement may in fact have nothing behind it.
   */
  Provisional = 'provisional',
  /**
   * Links exist and every one of them is restricted to this viewer.
   * Rendered as "Uncovered for you".
   */
  AllRestricted = 'all_restricted',
}

export interface RequirementCoverageSummary {
  /** Requirements on the page. */
  total: number;
  /** Requirements at `approved` or beyond — the ones coverage is expected of. */
  approvedOrBeyond: number;
  covered: number;
  uncovered: number;
  provisional: number;
  /**
   * URNs whose resolution did not produce a verifiable answer, so an operator
   * can tell "ConqrPlan was down" apart from "there is genuinely no work".
   * Restricted URNs are deliberately NOT listed: naming them would tell the
   * viewer which items exist.
   */
  unresolvedSources: string[];
  /** Requirements expected to have coverage and lacking it. */
  gaps: Array<{
    requirementId: string;
    urn: string;
    title: string | null;
    state: string;
    coverage: CoverageState;
  }>;
}

/**
 * Decide coverage for one requirement from its resolved links.
 *
 * Order matters. "Some link is live" wins over everything else, because one
 * verifiable delivery item is enough to say work exists. Only when nothing is
 * verifiable do the degraded states apply, and `all_restricted` is checked
 * before `provisional` so a purely permission-driven outcome is never reported
 * as a data problem.
 */
export function coverageFor(models: PresentationModel[]): CoverageState {
  if (models.length === 0) return CoverageState.Uncovered;

  const hasVerifiable = models.some(
    (m) => m.state === ResolutionState.Live || m.state === ResolutionState.Stale,
  );
  if (hasVerifiable) return CoverageState.Covered;

  const allRestricted = models.every(
    (m) => m.state === ResolutionState.Restricted,
  );
  if (allRestricted) return CoverageState.AllRestricted;

  // Links exist but resolve to deleted / unavailable / not-found / disabled,
  // possibly mixed with restricted ones. Something is linked; whether it
  // delivers anything is unknown.
  return CoverageState.Provisional;
}

/** True when this state should be presented as delivery actually existing. */
export function countsAsCovered(state: CoverageState): boolean {
  return state === CoverageState.Covered;
}

/**
 * URNs worth reporting as unresolved.
 *
 * Restricted is excluded on purpose: it is a permission answer, not a failure,
 * and listing the URN would confirm to the viewer that a specific item exists.
 */
export function unresolvedFrom(models: PresentationModel[]): string[] {
  return models
    .filter(
      (m) =>
        m.state === ResolutionState.SourceUnavailable ||
        m.state === ResolutionState.NotFound ||
        m.state === ResolutionState.IntegrationDisabled,
    )
    .map((m) => m.urn);
}
