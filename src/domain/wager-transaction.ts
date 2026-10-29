import { Money } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

export enum WagerTransactionKind {
  Opening = "OPENING",
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // transação aceita, mas ainda não aplicada
  PendingReference = "PENDING_REFERENCE", // aguardando transação referenciada
  Processed = "PROCESSED", // aplicada (terminal)
  Rejected = "REJECTED", // violação da regra de negocio(terminal)
  Failed = "FAILED", // erro permanente de infra ( terminal, auditável)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  createdAt: Date;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidWagerTransactionError";
  }
}

// Incluindo taxonomia para facil identificação
export enum FailureCode {
  InsufficientBalance = "INSUFFICIENT_BALANCE",
  InsufficientBalanceForReversal = "INSUFFICIENT_BALANCE_FOR_REVERSAL",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  InvalidReference = "INVALID_REFERENCE",
  AlreadyReversed = "ALREADY_REVERSED",
  PermanentInfrastructureError = "PERMANENT_INFRASTRUCTURE_ERROR",
  WalletMismatch = "WALLET_MISMATCH",
  PlayerMismatch = "PLAYER_MISMATCH",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  MonetaryLimitExceeded = "MONETARY_LIMIT_EXCEEDED",
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransactionStateError";
  }
}

export class InvalidReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceError";
  }
}

export class ReferenceNotReadyError extends Error {
  constructor() {
    super("A referência ainda não está disponível para processamento.");
    this.name = "ReferenceNotReadyError";
  }
}

export class WagerTransaction {
  public readonly id: string;
  public readonly providerId: string;
  public readonly externalTransactionId: string;
  public readonly idempotencyKey: string;
  public readonly payloadHash: string;
  public readonly walletId: string;
  public readonly playerId: string;
  public readonly roundId: string;
  public readonly gameId: string;
  public readonly kind: WagerTransactionKind;
  public readonly money: Money;
  public readonly referenceExternalTransactionId: string | undefined; // id no provedor - não id interno
  public readonly createdAt: Date;

  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt =
      state.processedAt === undefined
        ? undefined
        : new Date(state.processedAt.getTime());
  }

  static create(
    props: CreateWagerTransactionProps,
    at: Date = new Date(),
  ): WagerTransaction {
    const identifiers = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (identifiers.some((value) => value.trim() === "")) {
      throw new InvalidWagerTransactionError(
        "Os identificadores e o hash são obrigatórios.",
      );
    }

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError("Tipo de operação inválido.");
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      props.referenceExternalTransactionId.trim() === ""
    ) {
      throw new InvalidWagerTransactionError(
        "A referência informada não pode ser vazia.",
      );
    }

    const transaction = new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      createdAt: at,
    });

    if (
      transaction.requiresReference() &&
      props.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidWagerTransactionError(
        "REFUND e ROLLBACK exigem uma referência.",
      );
    }

    if (
      props.money.isNegative() ||
      (transaction.affectsBalance() && !props.money.isPositive())
    ) {
      throw new InvalidWagerTransactionError(
        "Operações financeiras exigem valor positivo; LOSS aceita zero.",
      );
    }

    return transaction;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (this.referenceExternalTransactionId !== undefined) {
      if (reference === undefined) {
        throw new ReferenceNotReadyError();
      }

      this.validateReference(reference);
    } else if (reference !== undefined) {
      throw new InvalidReferenceError(
        "A operação não declarou uma referência externa.",
      );
    }

    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        if (reference === undefined) {
          throw new ReferenceNotReadyError();
        }

        return reference.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;

      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError(
          "LOSS não possui direção de ledger.",
        );

      default:
        throw new InvalidWagerTransactionError("Tipo de operação inválido.");
    }
  }

  private validateReference(reference: WagerTransaction): void {
    const matchesContext =
      reference.id !== this.id &&
      reference.externalTransactionId === this.referenceExternalTransactionId &&
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;

    if (!matchesContext) {
      throw new InvalidReferenceError(
        "A referência não corresponde ao contexto da operação.",
      );
    }

    const acceptsBet =
      (this.kind === WagerTransactionKind.Win ||
        this.kind === WagerTransactionKind.Refund) &&
      reference.kind === WagerTransactionKind.Bet;

    const acceptsRollback =
      this.kind === WagerTransactionKind.Rollback &&
      (reference.kind === WagerTransactionKind.Bet ||
        reference.kind === WagerTransactionKind.Win ||
        reference.kind === WagerTransactionKind.Refund);

    if (!acceptsBet && !acceptsRollback) {
      throw new InvalidReferenceError(
        "Tipo de referência não permitido para esta operação.",
      );
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      if (!reference.isTerminal()) {
        throw new ReferenceNotReadyError();
      }

      throw new InvalidReferenceError(
        "Uma operação rejeitada ou com falha não pode ser referenciada.",
      );
    }

    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new InvalidReferenceError(
        "A reversão não pode ter valor diferente de valor da referência.",
      );
    }
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
// -- consultas de dominio --
  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss; // false para LOSS
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback // true para REFUND e ROLLBACK
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt === undefined
      ? undefined
      : new Date(this._processedAt.getTime());
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        "Somente PENDING pode passar para PENDING_REFERENCE.",
      );
    }

    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidWagerTransactionError(
        "Não é possível aguardar uma referência não informada.",
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date = new Date(),
  ): void {
    this.assertNotTerminal();

    if (
      referenceTransactionId !== undefined &&
      referenceTransactionId.trim() === ""
    ) {
      throw new InvalidWagerTransactionError(
        "O identificador interno da referência não pode ser vazio.",
      );
    }

    const hasExternalReference =
      this.referenceExternalTransactionId !== undefined;

    const hasInternalReference = referenceTransactionId !== undefined;

    if (hasExternalReference !== hasInternalReference) {
      throw new InvalidWagerTransactionError(
        "A referência externa deve corresponder a uma referência interna.",
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = new Date(at.getTime());
    this._status = WagerTransactionStatus.Processed;
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();

    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `A transação em ${this._status} não pode mudar de estado.`,
      );
    }
  }
}
