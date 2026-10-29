export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
}

export interface InboxMessageState extends ReceiveInboxProps {
  receivedAt: Date;
  processedAt?: Date;
}

export class InvalidInboxMessageError extends Error {
  constructor() {
    super("Os identificadores e o hash da mensagem são obrigatórios.");
    this.name = "InvalidInboxMessageError";
  }
}

export class InvalidInboxStateError extends Error {
  constructor() {
    super("A mensagem já foi marcada como processada.");
    this.name = "InvalidInboxStateError";
  }
}

export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;

  private readonly receivedAtMs: number;
  private _processedAtMs: number | undefined;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.receivedAtMs = state.receivedAt.getTime();
    this._processedAtMs = state.processedAt?.getTime();
  }

  static receive(
    props: ReceiveInboxProps,
    at: Date = new Date(),
  ): InboxMessage {
    const required = [props.messageId, props.consumerName, props.payloadHash];

    if (required.some((value) => value.trim() === "")) {
      throw new InvalidInboxMessageError();
    }

    return new InboxMessage({
      ...props,
      receivedAt: at,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return new Date(this.receivedAtMs);
  }

  get processedAt(): Date | undefined {
    return this._processedAtMs === undefined
      ? undefined
      : new Date(this._processedAtMs);
  }

  isProcessed(): boolean {
    return this._processedAtMs !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markProcessed(at: Date = new Date()): void {
    if (this.isProcessed()) {
      throw new InvalidInboxStateError();
    }

    this._processedAtMs = at.getTime();
  }
}
