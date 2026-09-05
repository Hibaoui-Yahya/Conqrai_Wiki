import { atom } from "jotai";

/**
 * Drives "Mark as requirement" from the editor bubble menu.
 *
 * Same shape as the create-work-item draft atom it sits beside: the bubble
 * menu owns the selection and nothing else, a page-scoped host owns the page
 * id and the API call. Keeping the editor ignorant of the integration is what
 * lets requirement authoring exist without touching the editor's schema.
 */
export interface MarkRequirementDraft {
  open: boolean;
  /** The selected text, which becomes the requirement's title. */
  title: string;
}

export const markRequirementDraftAtom = atom<MarkRequirementDraft>({
  open: false,
  title: "",
});
