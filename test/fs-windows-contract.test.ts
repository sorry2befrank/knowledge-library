// S2e item B: the shared Fs contract against the real kl-fs helper on Windows. Same IDs, names and assertions as the memory
// run; a harness operation with no native equivalent throws held:<reason> and the gate records the case as held.
// On any other platform the file is skipped (listed in the turnover): the gate accepts a run only from win32.
import { describe } from "vitest";
import { runFsContract } from "./helpers/fs-contract.ts";
import { WindowsHarness, nativeLabel, onWindows } from "./helpers/s2e-windows-harness.ts";

describe.skipIf(!onWindows)("fs contract (windows-native)", () => {
  runFsContract(() => new WindowsHarness(), nativeLabel());
});
