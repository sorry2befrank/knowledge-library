// Generated from the LF-normalized repository DESIGN at build time, with no runtime filesystem read.
import { BUILD_DESIGN_SPEC } from "./design-spec.generated.ts";
export interface DesignSpec { revision: string; hash: string; status: string }

export async function designSpec(): Promise<DesignSpec> { return BUILD_DESIGN_SPEC; }
