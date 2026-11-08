import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { Logger } from "../../../core/observability/logger";

export abstract class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  protected abstract readonly name: string;
  protected abstract readonly idleDelayMs: number;

  protected constructor(protected readonly logger: Logger) {}

  protected abstract tick(): Promise<boolean>;

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
    this.logger.info({ context: this.name }, "worker started");
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info({ context: this.name }, "worker stopped");
  }

  private async run(): Promise<void> {
    while (this.running) {
      let busy = false;
      try {
        busy = await this.tick();
      } catch (error) {
        this.logger.warn({ err: error, context: this.name }, "worker iteration failed");
      }
      if (!busy && this.running) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idleDelayMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
