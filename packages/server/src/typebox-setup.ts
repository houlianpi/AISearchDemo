import { Settings } from "typebox/system";

/**
 * Must be imported before anything that pulls in pi.
 *
 * pi validates tool-call arguments with TypeBox, which by default JIT-compiles
 * validators via `new Function`. Workers forbids runtime code generation
 * ("Code generation from strings disallowed for this context"), so every tool
 * call fails. Disabling acceleration switches TypeBox to its interpreter, which
 * is slower but functionally identical.
 */
Settings.Set({ useAcceleration: false });
