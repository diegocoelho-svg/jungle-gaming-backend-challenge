import type { Subprocess } from "bun";

export interface RoleProcess {
  readonly role: string;
  output(): string;
  waitFor(text: string, timeoutMs?: number): Promise<void>;
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export function spawnRole(role: "api" | "consumer" | "workers", env: Record<string, string> = {}): RoleProcess {
  const child: Subprocess<"ignore", "pipe", "inherit"> = Bun.spawn(["bun", "src/main.ts"], {
    env: { ...process.env, APP_ROLE: role, LOG_LEVEL: "info", ...env },
    stdout: "pipe",
    stderr: "inherit",
  });

  let output = "";
  const decoder = new TextDecoder();
  const reading = (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk);
  })();

  return {
    role,
    output: () => output,
    async waitFor(text, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (!output.includes(text)) {
        if (Date.now() > deadline) throw new Error(`${role} did not log "${text}" within ${timeoutMs}ms`);
        await Bun.sleep(50);
      }
    },
    async kill(signal = "SIGKILL") {
      child.kill(signal);
      await child.exited;
      await reading;
    },
  };
}

export const count = (output: string, text: string): number => output.split(text).length - 1;
