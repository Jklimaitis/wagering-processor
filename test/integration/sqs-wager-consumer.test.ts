import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { InboxMessageRecord } from "../../src/infrastructure/database/inbox-message-record";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import { PostgresInboxWagerProcessor } from "../../src/infrastructure/database/postgres-inbox-wager-processor";
import { PostgresWagerProcessor } from "../../src/infrastructure/database/postgres-wager-processor";
import { WagerTransactionRecord } from "../../src/infrastructure/database/wager-transaction-record";
import { WalletLedgerEntryRecord } from "../../src/infrastructure/database/wallet-ledger-entry-record";
import { WalletMapper } from "../../src/infrastructure/database/wallet-mapper";
import { WalletRecord } from "../../src/infrastructure/database/wallet-record";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import {
  SqsAcknowledgementError,
  SqsWagerMessageHandler,
  WAGER_CONSUMER_NAME,
} from "../../src/infrastructure/messaging/sqs-wager-message-handler";
import { InvalidInputError } from "../../src/application/input-validation";
import { SqsWagerFailureHandler } from "../../src/infrastructure/messaging/sqs-wager-failure-handler";
import { MAX_SQS_ATTEMPTS } from "../../src/infrastructure/messaging/sqs-wager-failure-policy";
import {
  SqsWagerConsumer,
  type SqsWagerPollResult,
} from "../../src/infrastructure/messaging/sqs-wager-consumer";
import { setTimeout as delay } from "node:timers/promises";
import { LockMode } from "@mikro-orm/core";
import { fileURLToPath } from "node:url";
import { MetricsService } from "../../src/metrics.service";

const schema = `sqs_consumer_${crypto.randomUUID().replaceAll("-", "")}`;
const client = createSqsClient();

let orm: MikroORM;
let schemaCreated = false;
let queueUrl: string | undefined;
let dlqUrl: string | undefined;

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    migrations: {
      ...config.migrations,
      snapshot: false,
    },
  });

  await orm.connect();
  await orm.em.fork().execute(`create schema "${schema}"`);
  schemaCreated = true;

  await orm.migrator.up({ schema });
}, 30_000);

beforeEach(async () => {
  queueUrl = undefined;
  dlqUrl = undefined;

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: `consumer-dlq-${crypto.randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        MessageRetentionPeriod: "1209600",
      },
    }),
  );

  dlqUrl = dlq.QueueUrl;

  if (dlqUrl === undefined) {
    throw new Error("SQS não retornou a URL da DLQ de teste.");
  }

  const attributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["QueueArn"],
    }),
  );

  const dlqArn = attributes.Attributes?.QueueArn;

  if (dlqArn === undefined) {
    throw new Error("SQS não retornou o ARN da DLQ.");
  }

  const created = await client.send(
    new CreateQueueCommand({
      QueueName: `consumer-${crypto.randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: MAX_SQS_ATTEMPTS,
        }),
      },
    }),
  );

  queueUrl = created.QueueUrl;

  if (queueUrl === undefined) {
    throw new Error("SQS não retornou a URL da fila de teste.");
  }
});

afterEach(async () => {
  for (const url of [queueUrl, dlqUrl]) {
    if (url !== undefined) {
      await client.send(
        new DeleteQueueCommand({
          QueueUrl: url,
        }),
      );
    }
  }
});

afterAll(async () => {
  try {
    if (orm && schemaCreated) {
      await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    try {
      if (orm) {
        await orm.close(true);
      }
    } finally {
      client.destroy();
    }
  }
}, 30_000);

async function scenarioForTest() {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    initialBalance: Money.zero("BRL"),
  });

  const writer = orm.em.fork({ schema });
  writer.persist(WalletMapper.toRecord(wallet));
  await writer.flush();

  const common = {
    providerId: "consumer-test",
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
  };

  const fundingId = crypto.randomUUID();

  await new PostgresWagerProcessor(orm.em.fork({ schema })).process({
    ...common,
    id: fundingId,
    externalTransactionId: fundingId,
    idempotencyKey: `funding:${fundingId}`,
    kind: WagerTransactionKind.Win,
    money: Money.from({ amount: "100.00", currency: "BRL" }),
  });

  const externalId = crypto.randomUUID();

  const envelope = {
    messageId: crypto.randomUUID(),
    type: "WagerTransactionRequested",
    occurredAt: new Date().toISOString(),
    data: {
      ...common,
      externalTransactionId: externalId,
      idempotencyKey: `bet:${externalId}`,
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    },
  };

  return { wallet, envelope };
}

test("confirma saldo, ledger, inbox e outbox antes do ack real", async () => {
  const url = queueUrl;

  if (url === undefined) {
    throw new Error("Fila de teste não inicializada.");
  }

  const { wallet, envelope } = await scenarioForTest();

  await client.send(
    new SendMessageCommand({
      QueueUrl: url,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: wallet.id,
      MessageDeduplicationId: envelope.messageId,
    }),
  );

  const received = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: url,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 2,
    }),
  );

  const message = received.Messages?.[0];

  if (message === undefined) {
    throw new Error("Mensagem não recebida na fila de teste.");
  }

  let ackObserved = false;

  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === "DeleteMessageCommand") {
        const reader = orm.em.fork({ schema });

        const storedWallet = await reader.findOneOrFail(WalletRecord, {
          id: wallet.id,
        });

        const inbox = await reader.findOneOrFail(InboxMessageRecord, {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: envelope.messageId,
        });

        const transaction = await reader.findOneOrFail(WagerTransactionRecord, {
          providerId: envelope.data.providerId,
          externalTransactionId: envelope.data.externalTransactionId,
        });

        expect(storedWallet.balance).toBe("75.00");
        expect(inbox.processedAt).not.toBeNull();
        expect(transaction.status).toBe(WagerTransactionStatus.Processed);

        expect(
          await reader.count(WalletLedgerEntryRecord, {
            transactionId: transaction.id,
          }),
        ).toBe(1);

        expect(
          await reader.count(OutboxMessageRecord, {
            aggregateId: transaction.id,
          }),
        ).toBe(1);

        expect(
          await reader.count(OutboxMessageRecord, {
            aggregateId: wallet.id,
          }),
        ).toBe(2);

        ackObserved = true;
      }

      return next(args);
    },
    {
      step: "initialize",
      name: "verifyCommitBeforeAck",
    },
  );

  try {
    const handler = new SqsWagerMessageHandler(
      client,
      url,
      new PostgresInboxWagerProcessor(orm.em.fork({ schema })),
    );

    const outcome = await handler.handle(message);

    expect(ackObserved).toBe(true);
    expect(outcome.messageId).toBe(envelope.messageId);
    expect(outcome.result.status).toBe(WagerTransactionStatus.Processed);
    expect(outcome.result.idempotentReplay).toBe(false);
    expect(outcome.result.balance.amount).toBe("75.00");

    const reader = orm.em.fork({ schema });

    const totals = await reader.execute<{ balance: string }[]>(
      `
        select coalesce(
          sum(case when direction = 'CREDIT' then amount else -amount end),
          0
        )::numeric(20, 2)::text as balance
        from "${schema}".wallet_ledger_entries
        where wallet_id = ?
      `,
      [wallet.id],
    );

    const storedWallet = await reader.findOneOrFail(WalletRecord, {
      id: wallet.id,
    });

    expect(totals[0]?.balance).toBe(storedWallet.balance);
  } finally {
    client.middlewareStack.remove("verifyCommitBeforeAck");
  }
}, 20_000);

type TestEnvelope = Awaited<ReturnType<typeof scenarioForTest>>["envelope"];

function currentQueueUrl(): string {
  if (queueUrl === undefined) {
    throw new Error("Fila de teste não inicializada.");
  }

  return queueUrl;
}

function handlerForTest(): SqsWagerMessageHandler {
  return new SqsWagerMessageHandler(
    client,
    currentQueueUrl(),
    new PostgresInboxWagerProcessor(orm.em.fork({ schema })),
  );
}

async function receiveForTest(url = currentQueueUrl()) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
        ],
        MessageAttributeNames: ["All"],
      }),
    );

    const message = received.Messages?.[0];

    if (message !== undefined) {
      return message;
    }
  }

  throw new Error("Mensagem não recebida na fila de teste.");
}

async function enqueueForTest(envelope: TestEnvelope): Promise<void> {
  await client.send(
    new SendMessageCommand({
      QueueUrl: currentQueueUrl(),
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

async function sendAndReceiveForTest(envelope: TestEnvelope) {
  await enqueueForTest(envelope);
  return receiveForTest();
}

async function redeliverForTest(receiptHandle: string | undefined) {
  if (receiptHandle === undefined) {
    throw new Error("Recebimento sem receipt handle.");
  }

  await client.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: currentQueueUrl(),
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: 0,
    }),
  );

  return receiveForTest();
}

async function expectBalanceMatchesLedger(
  walletId: string,
  expectedBalance: string,
): Promise<void> {
  const reader = orm.em.fork({ schema });

  const stored = await reader.findOneOrFail(WalletRecord, {
    id: walletId,
  });

  const totals = await reader.execute<{ balance: string }[]>(
    `
      select coalesce(
        sum(case when direction = 'CREDIT' then amount else -amount end),
        0
      )::numeric(20, 2)::text as balance
      from "${schema}".wallet_ledger_entries
      where wallet_id = ?
    `,
    [walletId],
  );

  expect(stored.balance).toBe(expectedBalance);
  expect(totals[0]?.balance).toBe(stored.balance);
}

async function expectAppliedOnce(envelope: TestEnvelope): Promise<void> {
  const reader = orm.em.fork({ schema });

  const transaction = await reader.findOneOrFail(WagerTransactionRecord, {
    providerId: envelope.data.providerId,
    externalTransactionId: envelope.data.externalTransactionId,
  });

  expect(transaction.status).toBe(WagerTransactionStatus.Processed);

  expect(
    await reader.count(InboxMessageRecord, {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: envelope.messageId,
    }),
  ).toBe(1);

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: envelope.data.walletId,
    }),
  ).toBe(2);

  expect(
    await reader.count(OutboxMessageRecord, {
      aggregateId: transaction.id,
    }),
  ).toBe(1);

  expect(
    await reader.count(OutboxMessageRecord, {
      aggregateId: envelope.data.walletId,
    }),
  ).toBe(2);

  await expectBalanceMatchesLedger(envelope.data.walletId, "75.00");
}

test("mesmo messageId em duas mensagens SQS produz um único débito", async () => {
  const { envelope } = await scenarioForTest();
  const handler = handlerForTest();

  const firstMessage = await sendAndReceiveForTest(envelope);
  const first = await handler.handle(firstMessage);

  const secondMessage = await sendAndReceiveForTest(envelope);
  const second = await handler.handle(secondMessage);

  expect(secondMessage.MessageId).not.toBe(firstMessage.MessageId);

  expect(first.result.idempotentReplay).toBe(false);
  expect(second.result.idempotentReplay).toBe(true);
  expect(second.result.transactionId).toBe(first.result.transactionId);
  expect(second.result.balance).toEqual(first.result.balance);

  await expectAppliedOnce(envelope);
}, 20_000);

test("falha no commit impede ack e permite processar a reentrega", async () => {
  const { envelope } = await scenarioForTest();
  const message = await sendAndReceiveForTest(envelope);
  const handler = handlerForTest();

  const outboxBefore = await orm.em
    .fork({ schema })
    .count(OutboxMessageRecord, {});

  await orm.em.fork().execute(`
    alter table "${schema}".inbox_messages
    add constraint sqs_inbox_test_failure
    check (
      message_id <> '${envelope.messageId}'
      or processed_at is null
    )
  `);

  let ackCalls = 0;

  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === "DeleteMessageCommand") {
        ackCalls += 1;
      }

      return next(args);
    },
    {
      step: "initialize",
      name: "observeAckOnCommitFailure",
    },
  );

  try {
    await expect(handler.handle(message)).rejects.toMatchObject({
      code: "23514",
      constraint: "sqs_inbox_test_failure",
    });

    expect(ackCalls).toBe(0);
  } finally {
    client.middlewareStack.remove("observeAckOnCommitFailure");

    await orm.em.fork().execute(`
      alter table "${schema}".inbox_messages
      drop constraint sqs_inbox_test_failure
    `);
  }

  const reader = orm.em.fork({ schema });

  expect(
    await reader.findOne(InboxMessageRecord, {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: envelope.messageId,
    }),
  ).toBeNull();

  expect(
    await reader.findOne(WagerTransactionRecord, {
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
    }),
  ).toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: envelope.data.walletId,
    }),
  ).toBe(1);

  expect(await reader.count(OutboxMessageRecord, {})).toBe(outboxBefore);

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");

  const redelivered = await redeliverForTest(message.ReceiptHandle);

  expect(redelivered.MessageId).toBe(message.MessageId);

  const outcome = await handler.handle(redelivered);

  expect(outcome.result.idempotentReplay).toBe(false);

  await expectAppliedOnce(envelope);
}, 20_000);

test("falha no ack após commit não duplica efeitos na reentrega", async () => {
  const { envelope } = await scenarioForTest();
  const message = await sendAndReceiveForTest(envelope);
  const handler = handlerForTest();

  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName === "DeleteMessageCommand") {
        throw new Error("Falha simulada antes do envio do ack.");
      }

      return next(args);
    },
    {
      step: "initialize",
      name: "failAcknowledgement",
    },
  );

  try {
    await expect(handler.handle(message)).rejects.toBeInstanceOf(
      SqsAcknowledgementError,
    );
  } finally {
    client.middlewareStack.remove("failAcknowledgement");
  }

  await expectAppliedOnce(envelope);

  const redelivered = await redeliverForTest(message.ReceiptHandle);

  expect(redelivered.MessageId).toBe(message.MessageId);
  expect(redelivered.ReceiptHandle).not.toBe(message.ReceiptHandle);

  const outcome = await handler.handle(redelivered);

  expect(outcome.result.idempotentReplay).toBe(true);

  await expectAppliedOnce(envelope);
}, 20_000);

function currentDlqUrl(): string {
  if (dlqUrl === undefined) {
    throw new Error("DLQ de teste não inicializada.");
  }

  return dlqUrl;
}

function failureHandlerForTest(metrics?: MetricsService): SqsWagerFailureHandler {
  return new SqsWagerFailureHandler(client, currentQueueUrl(), currentDlqUrl(), metrics);
}

async function expectSourceQueueEmpty(): Promise<void> {
  const response = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: currentQueueUrl(),
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );

  expect(response.Attributes?.ApproximateNumberOfMessages).toBe("0");
  expect(response.Attributes?.ApproximateNumberOfMessagesNotVisible).toBe("0");
}

test("retry real preserva a mensagem e incrementa o contador no SQS", async () => {
  const metrics = new MetricsService();
  const { envelope } = await scenarioForTest();
  const message = await sendAndReceiveForTest(envelope);

  expect(message.Attributes?.ApproximateReceiveCount).toBe("1");

  const decision = await failureHandlerForTest(metrics).handle(
    message,
    new Error("Falha transitória simulada antes do processamento."),
  );

  expect(decision).toEqual({
    action: "RETRY",
    attempt: 1,
    delaySeconds: 1,
    reason: "TRANSIENT_ERROR",
  });

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");

  expect(await metrics.render()).toContain('wagering_retries_total{source="sqs"} 1');

  const redelivered = await receiveForTest();

  expect(redelivered.MessageId).toBe(message.MessageId);
  expect(redelivered.Attributes?.ApproximateReceiveCount).toBe("2");

  const outcome = await handlerForTest().handle(redelivered);

  expect(outcome.result.idempotentReplay).toBe(false);

  await expectAppliedOnce(envelope);
}, 20_000);

test("entrada inválida vai para DLQ com corpo e motivo preservados", async () => {
  const metrics = new MetricsService();
  const { envelope } = await scenarioForTest();
  envelope.data.kind = "OPENING";

  const message = await sendAndReceiveForTest(envelope);

  const failure = await handlerForTest()
    .handle(message)
    .then(
      () => {
        throw new Error("Era esperada uma falha de validação.");
      },
      (error: unknown) => error,
    );

  expect(failure).toBeInstanceOf(InvalidInputError);

  const decision = await failureHandlerForTest(metrics).handle(message, failure);
  expect(await metrics.render()).toContain('wagering_dlq_messages_total{reason="INVALID_INPUT"} 1');

  expect(decision).toEqual({
    action: "DLQ",
    attempt: 1,
    reason: "INVALID_INPUT",
  });

  const deadLetter = await receiveForTest(currentDlqUrl());

  expect(deadLetter.Body).toBe(message.Body);
  expect(deadLetter.Attributes?.MessageGroupId).toBe(envelope.data.walletId);
  expect(deadLetter.MessageAttributes?.failureReason?.StringValue).toBe(
    "INVALID_INPUT",
  );
  expect(deadLetter.MessageAttributes?.sourceMessageId?.StringValue).toBe(
    message.MessageId,
  );

  const reader = orm.em.fork({ schema });

  expect(
    await reader.findOne(InboxMessageRecord, {
      consumerName: WAGER_CONSUMER_NAME,
      messageId: envelope.messageId,
    }),
  ).toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: envelope.data.walletId,
    }),
  ).toBe(1);

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");
  await expectSourceQueueEmpty();
}, 20_000);

test("quinta tentativa transitória encaminha para DLQ", async () => {
  const { envelope } = await scenarioForTest();
  let message = await sendAndReceiveForTest(envelope);

  for (let attempt = 1; attempt < MAX_SQS_ATTEMPTS; attempt += 1) {
    message = await redeliverForTest(message.ReceiptHandle);
  }

  expect(message.Attributes?.ApproximateReceiveCount).toBe(
    String(MAX_SQS_ATTEMPTS),
  );

  const decision = await failureHandlerForTest().handle(
    message,
    new Error("Falha transitória persistente."),
  );

  expect(decision).toEqual({
    action: "DLQ",
    attempt: MAX_SQS_ATTEMPTS,
    reason: "RETRIES_EXHAUSTED",
  });

  const deadLetter = await receiveForTest(currentDlqUrl());

  expect(deadLetter.Body).toBe(message.Body);
  expect(deadLetter.MessageAttributes?.failureReason?.StringValue).toBe(
    "RETRIES_EXHAUSTED",
  );
  expect(deadLetter.MessageAttributes?.receiveCount?.StringValue).toBe(
    String(MAX_SQS_ATTEMPTS),
  );

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");
  await expectSourceQueueEmpty();
}, 20_000);

test("falha no envio à DLQ preserva a mensagem para nova tentativa", async () => {
  const { envelope } = await scenarioForTest();
  envelope.data.kind = "OPENING";

  const message = await sendAndReceiveForTest(envelope);
  const failure = new InvalidInputError("kind");

  const missingDlqUrl = currentDlqUrl().replace(
    /[^/]+$/,
    `missing-${crypto.randomUUID()}.fifo`,
  );

  const brokenHandler = new SqsWagerFailureHandler(
    client,
    currentQueueUrl(),
    missingDlqUrl,
  );

  await expect(brokenHandler.handle(message, failure)).rejects.toMatchObject({
    $metadata: {
      httpStatusCode: 400,
    },
  });

  const redelivered = await redeliverForTest(message.ReceiptHandle);

  expect(redelivered.MessageId).toBe(message.MessageId);
  expect(redelivered.Body).toBe(message.Body);

  const decision = await failureHandlerForTest().handle(redelivered, failure);

  expect(decision.action).toBe("DLQ");

  const deadLetter = await receiveForTest(currentDlqUrl());

  expect(deadLetter.Body).toBe(message.Body);
  expect(deadLetter.MessageAttributes?.failureReason?.StringValue).toBe(
    "INVALID_INPUT",
  );

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");
  await expectSourceQueueEmpty();
}, 20_000);

test("saldo insuficiente confirma rejeição com ack sem enviar para DLQ", async () => {
  const { envelope } = await scenarioForTest();
  envelope.data.money.amount = "180.00";

  const message = await sendAndReceiveForTest(envelope);
  const outcome = await handlerForTest().handle(message);

  expect(outcome.result.status).toBe(WagerTransactionStatus.Rejected);
  expect(outcome.result.failureCode).toBe(FailureCode.InsufficientBalance);
  expect(outcome.result.balance.amount).toBe("100.00");

  const reader = orm.em.fork({ schema });

  const transaction = await reader.findOneOrFail(WagerTransactionRecord, {
    id: outcome.result.transactionId,
  });

  expect(transaction.status).toBe(WagerTransactionStatus.Rejected);

  const inbox = await reader.findOneOrFail(InboxMessageRecord, {
    consumerName: WAGER_CONSUMER_NAME,
    messageId: envelope.messageId,
  });

  expect(inbox.processedAt).not.toBeNull();

  expect(
    await reader.count(WalletLedgerEntryRecord, {
      walletId: envelope.data.walletId,
    }),
  ).toBe(1);

  const events = await reader.find(OutboxMessageRecord, {
    aggregateId: transaction.id,
  });

  expect(events).toHaveLength(1);
  expect(events[0]?.eventType).toBe("WagerTransactionRejected");

  expect(
    await reader.count(OutboxMessageRecord, {
      aggregateId: envelope.data.walletId,
    }),
  ).toBe(1);

  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: currentDlqUrl(),
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );

  expect(dlqAttributes.Attributes?.ApproximateNumberOfMessages).toBe("0");

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");
  await expectSourceQueueEmpty();
}, 20_000);

test("consumer recebe, processa e confirma uma aposta real", async () => {
  const { envelope } = await scenarioForTest();
  await enqueueForTest(envelope);

  const consumer = new SqsWagerConsumer(
    client,
    currentQueueUrl(),
    handlerForTest(),
    failureHandlerForTest(),
    { waitTimeSeconds: 1 },
  );

  const result = await consumer.poll();

  expect(result.status).toBe("ACKNOWLEDGED");

  if (result.status !== "ACKNOWLEDGED") {
    throw new Error("Era esperado o processamento com ack.");
  }

  expect(result.outcome.messageId).toBe(envelope.messageId);
  expect(result.outcome.result.idempotentReplay).toBe(false);
  expect(result.heartbeatErrorName).toBeUndefined();

  await expectAppliedOnce(envelope);
  await expectSourceQueueEmpty();
}, 20_000);

test("consumer encaminha entrada inválida para DLQ", async () => {
  const { envelope } = await scenarioForTest();
  envelope.data.kind = "OPENING";

  await enqueueForTest(envelope);

  const consumer = new SqsWagerConsumer(
    client,
    currentQueueUrl(),
    handlerForTest(),
    failureHandlerForTest(),
    { waitTimeSeconds: 1 },
  );

  const result = await consumer.poll();

  expect(result.status).toBe("FAILURE_HANDLED");

  if (result.status !== "FAILURE_HANDLED") {
    throw new Error("Era esperado o tratamento da entrada inválida.");
  }

  expect(result.decision).toEqual({
    action: "DLQ",
    attempt: 1,
    reason: "INVALID_INPUT",
  });

  const deadLetter = await receiveForTest(currentDlqUrl());

  expect(deadLetter.Body).toBe(JSON.stringify(envelope));

  await expectBalanceMatchesLedger(envelope.data.walletId, "100.00");
  await expectSourceQueueEmpty();
}, 20_000);

test("heartbeat mantém a entrega invisível e encerramento aguarda a operação", async () => {
  const { envelope } = await scenarioForTest();
  await enqueueForTest(envelope);

  const shutdown = new AbortController();

  const consumer = new SqsWagerConsumer(
    client,
    currentQueueUrl(),
    handlerForTest(),
    failureHandlerForTest(),
    {
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 2,
    },
  );

  let notifyHeartbeat!: () => void;
  let heartbeatCount = 0;

  const heartbeatObserved = new Promise<void>((resolve) => {
    notifyHeartbeat = resolve;
  });

  client.middlewareStack.add(
    (next, context) => async (args) => {
      const result = await next(args);

      if (context.commandName === "ChangeMessageVisibilityCommand") {
        heartbeatCount += 1;
        notifyHeartbeat();
      }

      return result;
    },
    {
      step: "initialize",
      name: "observeConsumerHeartbeat",
    },
  );

  let polling: Promise<SqsWagerPollResult> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await orm.em.fork({ schema }).transactional(async (em) => {
      await em.findOneOrFail(
        WalletRecord,
        { id: envelope.data.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      polling = consumer.poll(shutdown.signal);

      await Promise.race([
        heartbeatObserved,
        polling.then(() => {
          throw new Error(
            "Consumer terminou antes de liberarmos o lock da wallet.",
          );
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Heartbeat não foi confirmado pelo SQS."));
          }, 5_000);
        }),
      ]);

      // Simula o pedido de encerramento enquanto a operação está em andamento.
      shutdown.abort();

      // Ultrapassa a visibilidade inicial de dois segundos.
      await delay(2_200);

      expect(heartbeatCount).toBeGreaterThanOrEqual(2);

      const competingReceive = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: currentQueueUrl(),
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 0,
        }),
      );

      expect(competingReceive.Messages ?? []).toHaveLength(0);

      // O retorno deste callback libera o lock da wallet.
    });

    if (polling === undefined) {
      throw new Error("Consumer não foi iniciado.");
    }

    const result = await polling;

    expect(result.status).toBe("ACKNOWLEDGED");

    if (result.status !== "ACKNOWLEDGED") {
      throw new Error("A operação em andamento deveria terminar com ack.");
    }

    expect(result.heartbeatErrorName).toBeUndefined();
    expect(result.outcome.result.status).toBe(WagerTransactionStatus.Processed);

    await expectAppliedOnce(envelope);
    await expectSourceQueueEmpty();

    expect(await consumer.poll(shutdown.signal)).toEqual({
      status: "STOPPED",
    });
  } finally {
    shutdown.abort();

    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (polling !== undefined) {
      await Promise.allSettled([polling]);
    }

    client.middlewareStack.remove("observeConsumerHeartbeat");
  }
}, 20_000);

function startConsumerProcess(pauseBeforeAck = false) {
  const queueName = new URL(currentQueueUrl()).pathname.split("/").at(-1);
  const dlqName = new URL(currentDlqUrl()).pathname.split("/").at(-1);

  if (!queueName || !dlqName) {
    throw new Error("URLs das filas de teste inválidas.");
  }

  const workerPath = fileURLToPath(
    new URL(
      pauseBeforeAck
        ? "../helpers/wager-before-ack-worker.ts"
        : "../../src/workers/wager-worker.ts",
      import.meta.url,
    ),
  );

  let notifyBeforeAck!: () => void;

  const beforeAck = new Promise<void>((resolve) => {
    notifyBeforeAck = resolve;
  });

  const worker = Bun.spawn([process.execPath, workerPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATABASE_SCHEMA: schema,
      SQS_QUEUE_NAME: queueName,
      SQS_DLQ_NAME: dlqName,
      METRICS_PORT: "0",
    },
    timeout: 20_000,
    killSignal: "SIGKILL",
    ...(pauseBeforeAck
      ? {
          serialization: "json" as const,
          ipc(message: unknown) {
            if (message === "before-ack") {
              notifyBeforeAck();
            }
          },
        }
      : {}),
  });

  let output = "";

  const stdout = (async () => {
    const reader = worker.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) {
          break;
        }

        output += decoder.decode(chunk.value, { stream: true });
      }

      output += decoder.decode();
      return output;
    } finally {
      reader.releaseLock();
    }
  })();

  return {
    worker,
    beforeAck,
    stdout,
    stderr: new Response(worker.stderr).text(),
    output: () => output,
  };
}

type ConsumerProcessHandle = ReturnType<typeof startConsumerProcess>;

async function consumerDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Timeout aguardando o processo consumidor."));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForConsumerEvent(
  handle: ConsumerProcessHandle,
  event: string,
): Promise<Record<string, unknown>> {
  return consumerDeadline(
    (async () => {
      for (;;) {
        for (const line of handle.output().split("\n").slice(0, -1)) {
          let decoded: unknown;
          try { decoded = JSON.parse(line); } catch { continue; }
          if (decoded !== null && typeof decoded === "object" &&
              "event" in decoded && decoded.event === event) {
            return decoded as Record<string, unknown>;
          }
        }
        if (
          handle.worker.exitCode !== null ||
          handle.worker.signalCode !== null
        ) {
          throw new Error(
            `Worker encerrou antes de ${event}: ` +
              `${handle.output()} ${await handle.stderr}`,
          );
        }

        await delay(20);
      }
    })(),
  );
}

async function cleanupConsumerProcess(
  handle: ConsumerProcessHandle,
): Promise<void> {
  if (handle.worker.exitCode === null && handle.worker.signalCode === null) {
    handle.worker.kill("SIGKILL");
  }

  await Promise.allSettled([
    handle.worker.exited,
    handle.stdout,
    handle.stderr,
  ]);
}

test("processo consumidor expõe métricas, deduplica e encerra com SIGTERM", async () => {
  const { envelope } = await scenarioForTest();
  const handle = startConsumerProcess();

  try {
    const ready = await waitForConsumerEvent(handle, "wager_worker_ready");
    if (typeof ready.metricsPort !== "number") throw new Error("Porta de métricas ausente.");
    const metricsUrl = `http://127.0.0.1:${ready.metricsPort}/metrics`;
    await enqueueForTest(envelope);
    await waitForConsumerEvent(handle, "wager_message_acknowledged");
    await enqueueForTest(envelope);
    const metrics = await consumerDeadline((async () => {
      for (;;) {
        const response = await fetch(metricsUrl, { signal: AbortSignal.timeout(2_000) });
        expect(response.status).toBe(200);
        const text = await response.text();
        if (text.includes('wagering_duplicates_total{source="sqs"} 1') &&
            text.includes('wagering_processing_duration_seconds_count{source="sqs"} 2')) {
          return text;
        }
        await delay(20);
      }
    })());
    expect(metrics).toContain('wagering_transaction_results_total{source="sqs",status="PROCESSED"} 1');
    await expectAppliedOnce(envelope);
    await expectSourceQueueEmpty();

    handle.worker.kill("SIGTERM");

    expect(await consumerDeadline(handle.worker.exited)).toBe(0);

    const output = await handle.stdout;

    expect(output).toContain('"event":"wager_worker_stopping"');
    expect(output).toContain('"event":"wager_worker_stopped"');
    expect(output).not.toContain('"event":"wager_worker_failed"');
  } finally {
    await cleanupConsumerProcess(handle);
  }
}, 30_000);

test("queda após commit e antes do ack permite replay em novo processo", async () => {
  const { envelope } = await scenarioForTest();
  await enqueueForTest(envelope);

  const first = startConsumerProcess(true);
  let second: ConsumerProcessHandle | undefined;

  try {
    await consumerDeadline(
      Promise.race([
        first.beforeAck,
        first.worker.exited.then(async () => {
          throw new Error(
            `Primeiro worker encerrou antes do ack: ${await first.stderr}`,
          );
        }),
      ]),
    );

    // Uma conexão independente comprova o commit antes da queda.
    await expectAppliedOnce(envelope);

    const reader = orm.em.fork({ schema });

    const transaction = await reader.findOneOrFail(WagerTransactionRecord, {
      providerId: envelope.data.providerId,
      externalTransactionId: envelope.data.externalTransactionId,
    });

    const eventFilter = {
      $or: [
        { aggregateId: envelope.data.walletId },
        { aggregateId: transaction.id },
      ],
    };

    const eventsBefore = await reader.find(OutboxMessageRecord, eventFilter);

    const eventIdsBefore = eventsBefore.map((event) => event.id).sort();

    first.worker.kill("SIGKILL");
    await consumerDeadline(first.worker.exited);

    expect(first.worker.signalCode).toBe("SIGKILL");

    second = startConsumerProcess();

    await waitForConsumerEvent(second, "wager_message_acknowledged");

    expect(second.worker.pid).not.toBe(first.worker.pid);

    second.worker.kill("SIGTERM");

    expect(await consumerDeadline(second.worker.exited)).toBe(0);

    const output = await second.stdout;

    expect(output).toContain('"idempotentReplay":true');
    expect(output).toContain(`"transactionId":"${transaction.id}"`);

    await expectAppliedOnce(envelope);
    await expectSourceQueueEmpty();

    const eventsAfter = await orm.em
      .fork({ schema })
      .find(OutboxMessageRecord, eventFilter);

    expect(eventsAfter.map((event) => event.id).sort()).toEqual(eventIdsBefore);
  } finally {
    await cleanupConsumerProcess(first);

    if (second !== undefined) {
      await cleanupConsumerProcess(second);
    }
  }
}, 30_000);
