import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ReadinessService, type ReadinessReport } from "./readiness.service";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(ReadinessService)
    private readonly readiness: ReadinessService,
  ) {}

  @Get("live")
  live(): { status: string } {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(
    @Res({ passthrough: true })
    response: {
      status(code: number): unknown;
    },
  ): Promise<ReadinessReport> {
    const report = await this.readiness.check();

    response.status(report.status === "ok" ? 200 : 503);

    return report;
  }
}
