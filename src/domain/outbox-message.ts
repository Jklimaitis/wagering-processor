import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class InvalidOutboxStateError extends Error {
  constructor() {
    super("Uma mensagem publicada não pode ser alterada.");
    this.name = "InvalidOutboxStateError";
  }
}

export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;

  private readonly payloadSnapshot: Readonly<Record<string, unknown>>;

  private readonly occurredAtMs: number;
  private _attempts: number;
  private _nextAttemptAtMs: number | undefined;
  private _publishedAtMs: number | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payloadSnapshot = structuredClone(state.payload);
    this.occurredAtMs = state.occurredAt.getTime();
    this._attempts = state.attempts;
    this._nextAttemptAtMs = state.nextAttemptAt?.getTime();
    this._publishedAtMs = state.publishedAt?.getTime();
  }

  static enqueue<T>(event: IntegrationEvent<T>): OutboxMessage {
    // Normaliza para a representação JSON que será persistida.
    const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<
      string,
      unknown
    >;

    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload,
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get payload(): Readonly<Record<string, unknown>> {
    return structuredClone(this.payloadSnapshot);
  }

  get occurredAt(): Date {
    return new Date(this.occurredAtMs);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAtMs === undefined
      ? undefined
      : new Date(this._nextAttemptAtMs);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAtMs === undefined
      ? undefined
      : new Date(this._publishedAtMs);
  }

  isPending(): boolean {
    return this._publishedAtMs === undefined;
  }

  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAtMs === undefined ||
        this._nextAttemptAtMs <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();

    this._publishedAtMs = at.getTime();
    this._nextAttemptAtMs = undefined;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();

    this._attempts += 1;

    const exponent = Math.min(this._attempts - 1, 9);
    const delayMs = Math.min(1_000 * 2 ** exponent, 300_000);

    this._nextAttemptAtMs = now.getTime() + delayMs;
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidOutboxStateError();
    }
  }
}
