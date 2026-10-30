import { Controller, Get, Header, Inject } from "@nestjs/common";
import { Registry } from "prom-client";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(MetricsService)
    private readonly metrics: MetricsService,
  ) {}

  @Get()
  @Header("Content-Type", Registry.PROMETHEUS_CONTENT_TYPE)
  render(): Promise<string> {
    return this.metrics.render();
  }
}
