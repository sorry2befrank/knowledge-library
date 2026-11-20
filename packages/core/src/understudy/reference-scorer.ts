// Pure reference signal only. Claim density grants no truth, ranking or eligibility authority.
import { perishability, type Perishability } from "../../../../vendor/perishability.ts";
export function scoreReferencePerishability(text: string): Perishability {
  if (typeof text !== "string") throw new TypeError("reference.scorer-input");
  return perishability(text);
}
