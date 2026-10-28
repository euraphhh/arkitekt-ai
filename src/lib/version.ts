import pkg from "../../package.json";

// Single source of truth: package.json. Bump it there.
export const VERSION: string = pkg.version;
