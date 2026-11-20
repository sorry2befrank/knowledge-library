// Physical Fs port and synthetic memory model; no native adapter or movement executor.
export * from "./fs.ts";
export { MemoryFs, ModelCrash, type MemoryOperation } from "./memory.ts";
