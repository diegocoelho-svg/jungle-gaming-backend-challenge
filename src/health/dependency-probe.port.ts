export const DEPENDENCY_PROBES = Symbol("DEPENDENCY_PROBES");

export interface DependencyProbe {
  readonly name: string;
  check(signal: AbortSignal): Promise<void>;
}
