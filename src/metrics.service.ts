import { Injectable } from "@nestjs/common";
import { Counter, Registry } from "prom-client";

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly reconciliations = new Counter<"result">({
    name: "wagering_reconciliations_total",
    help: "Wallet reconciliations by consistency result",
    labelNames: ["result"],
    registers: [this.registry],
  });

  constructor() {
    this.reconciliations.labels("consistent").inc(0);
    this.reconciliations.labels("inconsistent").inc(0);
  }

  recordReconciliation(consistent: boolean): void {
    this.reconciliations
      .labels(consistent ? "consistent" : "inconsistent")
      .inc();
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}
