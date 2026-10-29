import type { OutboxMessage } from "../domain/outbox-message";

export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
