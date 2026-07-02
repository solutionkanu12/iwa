// Browser polyfills for circomlibjs, imported once before anything that uses it.
//
// circomlibjs (via ffjavascript and the wasm builder) expects Node's Buffer and
// a `global` object. Vite's browser build provides neither, so we attach them to
// globalThis. Only the app entry (main.tsx) imports this; the landing, litepaper,
// and roadmap entries never load circomlibjs and stay untouched.

import { Buffer } from "buffer";

const g = globalThis as unknown as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
};

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;
