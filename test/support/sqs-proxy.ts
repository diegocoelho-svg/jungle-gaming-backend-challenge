export type SqsAction = "DeleteMessage" | "SendMessageBatch" | "ReceiveMessage" | "ChangeMessageVisibility";

interface Hold {
  action: SqsAction;
  forwardFirst: boolean;
  reached: () => void;
}

export interface SqsProxy {
  readonly endpoint: string;
  hold(action: SqsAction, options?: { forwardFirst?: boolean }): Promise<void>;
  calls(action: SqsAction): number;
  outage(down: boolean): void;
  stop(): void;
}

const actionOf = (request: Request): string => request.headers.get("x-amz-target")?.replace("AmazonSQS.", "") ?? "";

export function startSqsProxy(upstream: string): SqsProxy {
  const holds: Hold[] = [];
  let down = false;
  const seen = new Map<string, number>();
  const never = new Promise<Response>(() => undefined);

  const forward = async (request: Request, body: ArrayBuffer): Promise<Response> => {
    const target = new URL(new URL(request.url).pathname + new URL(request.url).search, upstream);
    const headers = new Headers(request.headers);
    headers.delete("host");
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: body.byteLength > 0 ? body : undefined,
    });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const action = actionOf(request);
      seen.set(action, (seen.get(action) ?? 0) + 1);
      const body = await request.arrayBuffer();
      if (down) return new Response("Service Unavailable", { status: 503 });
      const index = holds.findIndex((hold) => hold.action === action);
      if (index === -1) return forward(request, body);

      const [hold] = holds.splice(index, 1);
      if (hold!.forwardFirst) await forward(request, body);
      hold!.reached();
      return never;
    },
  });

  return {
    endpoint: `http://localhost:${server.port}`,
    hold(action, { forwardFirst = false } = {}) {
      return new Promise<void>((reached) => {
        holds.push({ action, forwardFirst, reached });
      });
    },
    calls: (action) => seen.get(action) ?? 0,
    outage: (value) => {
      down = value;
    },
    stop: () => server.stop(true),
  };
}

export async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}
