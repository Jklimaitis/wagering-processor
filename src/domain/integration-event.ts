export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

export type IntegrationEventEnvelope<T> = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: Readonly<T>;
};

export class InvalidIntegrationEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIntegrationEventError";
  }
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;

  private readonly occurredAtMs: number;
  private readonly dataSnapshot: T;

  protected constructor(props: IntegrationEventProps<T>) {
    const identifiers = [props.eventId, props.aggregateId, props.correlationId];

    if (props.causationId !== undefined) {
      identifiers.push(props.causationId);
    }

    if (identifiers.some((value) => value.trim() === "")) {
      throw new InvalidIntegrationEventError(
        "Os identificadores do evento não podem ser vazios.",
      );
    }

    if (!Number.isFinite(props.occurredAt.getTime())) {
      throw new InvalidIntegrationEventError(
        "A data do evento deve ser válida.",
      );
    }

    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAtMs = props.occurredAt.getTime();
    this.dataSnapshot = structuredClone(props.data);
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  get data(): Readonly<T> {
    return structuredClone(this.dataSnapshot);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}
