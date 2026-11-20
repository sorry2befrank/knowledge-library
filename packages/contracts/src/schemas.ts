// Versioned schema data shared by the build-time compiler and validators.
import noteVersionCitation from "../../../schemas/note-version-citation-v1.json" with { type: "json" };
import collectionPrivacy from "../../../schemas/collection-privacy-v1.json" with { type: "json" };
import admissionResult from "../../../schemas/admission-result-v1.json" with { type: "json" };
import signalsCases from "../../../schemas/signals-cases-v1.json" with { type: "json" };
import personaManifest from "../../../schemas/persona-manifest-v1.json" with { type: "json" };
import turnover from "../../../schemas/turnover-v1.json" with { type: "json" };
import libraryEvidence from "../../../schemas/library-evidence-v1.json" with { type: "json" };
import libraryEvidenceSigned from "../../../schemas/library-evidence-signed-v1.json" with { type: "json" };

export const SCHEMAS = {
  "note-version-citation/v1": noteVersionCitation,
  "collection-privacy/v1": collectionPrivacy,
  "admission-result/v1": admissionResult,
  "signals-cases/v1": signalsCases,
  "persona-manifest/v1": personaManifest,
  "turnover/v1": turnover,
  "library-evidence/v1": libraryEvidence,
  "library-evidence-signed/v1": libraryEvidenceSigned,
} as const;
export type SchemaName = keyof typeof SCHEMAS;
