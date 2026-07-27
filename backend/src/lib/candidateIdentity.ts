// Who a call was WITH, as something you can query on.
//
// Candidates are ephemeral here by design (see routes/candidates.ts): we keep
// no addressable candidate row, only an inline `candidate` object on each call.
// That is fine for rendering one call, and useless the moment you want "every
// note we've ever written about this person" — which is exactly what the notes
// feature needs, from the Dialer and from Interview Assist alike.
//
// So every call also carries two flat, indexable fields:
//
//   candidateUid — the OfferLetter candidate `uid`, when the recruiter picked
//                  the person out of the database. This is the real identity
//                  and the one to join on.
//   candidateKey — an identity that always exists. Falls back to the E.164
//                  phone, then the lowercased email, so a manual dial to a
//                  number that isn't in the DB still groups its own history
//                  together instead of scattering one note per call.
//
// Both are null only when we know literally nothing about the other party
// (an inbound call from a withheld number).

export interface CandidateIdentityInput {
  uid?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** E.164-ish normaliser, matching normalizeIndianNumber's output shape. */
function normalizePhone(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return null;
}

/**
 * Resolve the flat identity fields for a call.
 *
 * @param cand           the inline candidate payload, if any
 * @param fallbackPhone  the dialled / calling number, used when the candidate
 *                       object carries no phone of its own (manual dial,
 *                       inbound call)
 */
export function candidateIdentity(
  cand: CandidateIdentityInput | null | undefined,
  fallbackPhone?: string | null,
): { candidateUid: string | null; candidateKey: string | null } {
  const uid = (cand?.uid ?? "").trim() || null;
  const phone = normalizePhone(cand?.phone) ?? normalizePhone(fallbackPhone);
  const email = (cand?.email ?? "").trim().toLowerCase() || null;
  return { candidateUid: uid, candidateKey: uid ?? phone ?? email };
}
