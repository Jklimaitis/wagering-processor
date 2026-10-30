import { Registry } from "prom-client";
import type { MetricsService } from "../metrics.service";

export function startWorkerMetrics(
  metrics: MetricsService,
  refresh?: () => Promise<void>,
) {
  const input = process.env.METRICS_PORT ?? "0";
  if (!/^(0|[1-9][0-9]{0,4})$/.test(input) || Number(input) > 65535) {
    throw new Error("METRICS_PORT deve estar entre 0 e 65535.");
  }
  return Bun.serve({
    hostname: "0.0.0.0",
    port: Number(input),
    async fetch(request) {
      if (request.method !== "GET" || new URL(request.url).pathname !== "/metrics") {
        return new Response("Not Found", { status: 404 });
      }
      try {
        await refresh?.();
        return new Response(await metrics.render(), {
          headers: { "content-type": Registry.PROMETHEUS_CONTENT_TYPE },
        });
      } catch {
        return new Response("Metrics temporarily unavailable", { status: 503 });
      }
    },
  });
}
