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
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import {
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

const schema = `sqs_consumer_${crypto.randomUUID().replaceAll("-", "")}`;
const client = createSqsClient();

let orm: MikroORM;
let schemaCreated = false;
let queueUrl: string | undefined;

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

  const created = await client.send(
    new CreateQueueCommand({
      QueueName: `consumer-${crypto.randomUUID()}.fifo`,
      Attributes: {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
      },
    }),
  );

  queueUrl = created.QueueUrl;

  if (queueUrl === undefined) {
    throw new Error("SQS não retornou a URL da fila de teste.");
  }
});

afterEach(async () => {
  if (queueUrl !== undefined) {
    await client.send(
      new DeleteQueueCommand({
        QueueUrl: queueUrl,
      }),
    );
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

async function receiveForTest() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: currentQueueUrl(),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const message = received.Messages?.[0];

    if (message !== undefined) {
      return message;
    }
  }

  throw new Error("Mensagem não recebida na fila de teste.");
}

async function sendAndReceiveForTest(envelope: TestEnvelope) {
  await client.send(
    new SendMessageCommand({
      QueueUrl: currentQueueUrl(),
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: envelope.data.walletId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );

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
