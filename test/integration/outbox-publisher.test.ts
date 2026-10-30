import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { EventPublisher } from "../../src/application/event-publisher";
import { Money } from "../../src/domain/money";
import { OutboxMessage } from "../../src/domain/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../src/domain/wager-transaction";
import { WagerTransactionProcessed } from "../../src/domain/wager-transaction-events";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { OutboxMessageMapper } from "../../src/infrastructure/database/outbox-message-mapper";
import { OutboxMessageRecord } from "../../src/infrastructure/database/outbox-message-record";
import { PostgresOutboxPublisher } from "../../src/infrastructure/database/postgres-outbox-publisher";
import type { OutboxPublishResult } from "../../src/infrastructure/database/postgres-outbox-publisher";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { createSqsClient } from "../../src/infrastructure/messaging/sqs-client";
import { SqsEventPublisher } from "../../src/infrastructure/messaging/sqs-event-publisher";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LockMode } from "@mikro-orm/core";
import { MetricsService } from "../../src/metrics.service";

const schema = `outbox_publisher_${crypto.randomUUID().replaceAll("-", "")}`;

test("outbox lag mede o evento pendente e volta a zero após publicar", async () => {
  const writer = orm.em.fork({ schema });
  const record = outboxRecordForTest();
  record.occurredAt = new Date(Date.now() - 10_000);
  record.payload.occurredAt = record.occurredAt.toISOString();
  writer.persist(record);
  await writer.flush();

  const metrics = new MetricsService();
  await metrics.refreshOutbox(orm.em.fork({ schema }));
  const line = (await metrics.render()).split("\n")
    .find((value) => value.startsWith("wagering_outbox_lag_seconds "));
  expect(Number(line?.split(" ").at(-1))).toBeGreaterThanOrEqual(9);

  await new PostgresOutboxPublisher(orm.em.fork({ schema }), {
    publish: async () => {},
  }).publishNext();
  await metrics.refreshOutbox(orm.em.fork({ schema }));
  expect(await metrics.render()).toContain("wagering_outbox_lag_seconds 0");
});

let orm: MikroORM;
let schemaCreated = false;

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
  await orm.em.fork().execute(`delete from "${schema}".outbox_messages`);
});

afterAll(async () => {
  if (!orm) {
    return;
  }

  try {
    if (schemaCreated) {
      await orm.em.fork().execute(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    await orm.close(true);
  }
}, 30_000);

function outboxRecordForTest(): OutboxMessageRecord {
  const id = crypto.randomUUID();

  const transaction = WagerTransaction.create({
    id,
    providerId: "publisher-test",
    externalTransactionId: id,
    idempotencyKey: `publisher-test:${id}`,
    payloadHash: "test-hash",
    walletId: crypto.randomUUID(),
    playerId: crypto.randomUUID(),
    roundId: "round-1",
    gameId: "game-1",
    kind: WagerTransactionKind.Loss,
    money: Money.zero("BRL"),
  });

  transaction.markProcessed(undefined);

  const event = WagerTransactionProcessed.from(transaction, {
    eventId: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    occurredAt: new Date(),
  });

  return OutboxMessageMapper.toRecord(OutboxMessage.enqueue(event));
}

async function seedOutbox(): Promise<OutboxMessageRecord> {
  const record = outboxRecordForTest();
  const writer = orm.em.fork({ schema });

  writer.persist(record);
  await writer.flush();

  return record;
}

async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("Timeout aguardando o publisher."));
        }, 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

test("publica somente após o commit e registra a publicação", async () => {
  const record = outboxRecordForTest();
  const sent: string[] = [];

  const transport: EventPublisher = {
    async publish(message) {
      sent.push(message.id);
    },
  };

  await orm.em.fork({ schema }).transactional(async (em) => {
    em.persist(record);
    await em.flush();

    const publisher = new PostgresOutboxPublisher(em, transport);

    expect((await publisher.publishNext()).status).toBe("IDLE");
    expect(sent).toEqual([]);
  });

  const publisher = new PostgresOutboxPublisher(
    orm.em.fork({ schema }),
    transport,
  );

  expect((await publisher.publishNext()).status).toBe("PUBLISHED");

  expect(sent).toEqual([record.id]);

  const stored = await orm.em
    .fork({ schema })
    .findOneOrFail(OutboxMessageRecord, { id: record.id });

  expect(stored.publishedAt).not.toBeNull();
  expect(stored.nextAttemptAt).toBeNull();
  expect(stored.attempts).toBe(0);

  expect((await publisher.publishNext()).status).toBe("IDLE");
  expect(sent).toHaveLength(1);
});

test("aguarda o horário do retry antes de tentar publicar", async () => {
  const record = await seedOutbox();
  const writer = orm.em.fork({ schema });

  const loaded = await writer.findOneOrFail(OutboxMessageRecord, {
    id: record.id,
  });

  const message = OutboxMessageMapper.toDomain(loaded);

  message.scheduleRetry(new Date(Date.now() + 60_000));

  loaded.attempts = message.attempts;
  loaded.nextAttemptAt = message.nextAttemptAt ?? null;
  await writer.flush();

  let calls = 0;

  const publisher = new PostgresOutboxPublisher(orm.em.fork({ schema }), {
    async publish() {
      calls += 1;
    },
  });

  expect((await publisher.publishNext()).status).toBe("IDLE");
  expect(calls).toBe(0);
});

test("falha no envio agenda retry e preserva o evento", async () => {
  const record = await seedOutbox();
  const before = new Date();

  const publisher = new PostgresOutboxPublisher(orm.em.fork({ schema }), {
    async publish() {
      throw new Error("Transporte indisponível.");
    },
  });

  expect((await publisher.publishNext()).status).toBe("RETRY_SCHEDULED");

  const stored = await orm.em
    .fork({ schema })
    .findOneOrFail(OutboxMessageRecord, { id: record.id });

  expect(stored.publishedAt).toBeNull();
  expect(stored.attempts).toBe(1);
  expect(stored.nextAttemptAt).not.toBeNull();

  expect(stored.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
    before.getTime() + 1_000,
  );

  expect(stored.payload).toEqual(record.payload);
});

test("dois publishers selecionam mensagens diferentes sem esperar o mesmo lock", async () => {
  await seedOutbox();
  await seedOutbox();

  let release!: () => void;
  let notifyStarted!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });

  const firstIds: string[] = [];
  const secondIds: string[] = [];

  const firstPublisher = new PostgresOutboxPublisher(orm.em.fork({ schema }), {
    async publish(message) {
      firstIds.push(message.id);
      notifyStarted();
      await gate;
    },
  });

  const secondPublisher = new PostgresOutboxPublisher(orm.em.fork({ schema }), {
    async publish(message) {
      secondIds.push(message.id);
    },
  });

  const first = firstPublisher.publishNext();
  let second: Promise<OutboxPublishResult> | undefined;

  try {
    await withDeadline(
      Promise.race([
        started,
        first.then(() => {
          throw new Error("Primeiro publisher encerrou antes da liberação.");
        }),
      ]),
    );

    second = secondPublisher.publishNext();

    expect((await withDeadline(second)).status).toBe("PUBLISHED");

    expect(firstIds).toHaveLength(1);
    expect(secondIds).toHaveLength(1);
    expect(firstIds[0]).not.toBe(secondIds[0]);
  } finally {
    release();

    await Promise.allSettled([
      first,
      ...(second === undefined ? [] : [second]),
    ]);
  }

  expect((await first).status).toBe("PUBLISHED");

  const records = await orm.em.fork({ schema }).find(OutboxMessageRecord, {});

  expect(records).toHaveLength(2);
  expect(records.every((record) => record.publishedAt !== null)).toBe(true);
}, 15_000);

async function withSqsQueue<T>(
  operation: (client: SQSClient, queueUrl: string) => Promise<T>,
): Promise<T> {
  const client = createSqsClient();
  let queueUrl: string | undefined;

  try {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: `outbox-${crypto.randomUUID()}.fifo`,
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

    return await operation(client, queueUrl);
  } finally {
    try {
      if (queueUrl !== undefined) {
        await client.send(
          new DeleteQueueCommand({
            QueueUrl: queueUrl,
          }),
        );
      }
    } finally {
      client.destroy();
    }
  }
}

test("publica o evento da outbox em uma fila FIFO real", async () => {
  await withSqsQueue(async (client, queueUrl) => {
    const record = await seedOutbox();

    const publisher = new PostgresOutboxPublisher(
      orm.em.fork({ schema }),
      new SqsEventPublisher(client, queueUrl),
    );

    expect(await publisher.publishNext()).toMatchObject({
      status: "PUBLISHED",
      eventId: record.id,
    });

    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: [
          "MessageGroupId",
          "MessageDeduplicationId",
        ],
      }),
    );

    const message = received.Messages?.[0];

    if (
      message === undefined ||
      message.Body === undefined ||
      message.ReceiptHandle === undefined
    ) {
      throw new Error("Evento não foi recebido na fila de teste.");
    }

    expect(JSON.parse(message.Body)).toEqual(record.payload);
    expect(message.Attributes?.MessageGroupId).toBe(record.aggregateId);
    expect(message.Attributes?.MessageDeduplicationId).toBe(record.id);

    const stored = await orm.em
      .fork({ schema })
      .findOneOrFail(OutboxMessageRecord, { id: record.id });

    expect(stored.publishedAt).not.toBeNull();
    expect(stored.nextAttemptAt).toBeNull();
    expect(stored.attempts).toBe(0);

    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    expect((await publisher.publishNext()).status).toBe("IDLE");
  });
}, 20_000);

test("recupera publicação aceita pelo SQS quando a confirmação no banco falha", async () => {
  await withSqsQueue(async (client, queueUrl) => {
    const record = await seedOutbox();
    const adapter = new SqsEventPublisher(client, queueUrl);
    const acceptedIds: string[] = [];

    const transport: EventPublisher = {
      async publish(message) {
        await adapter.publish(message);
        acceptedIds.push(message.id);
      },
    };

    await orm.em.fork().execute(`
      alter table "${schema}".outbox_messages
      add constraint outbox_publish_test_failure
      check (published_at is null)
    `);

    try {
      const firstPublisher = new PostgresOutboxPublisher(
        orm.em.fork({ schema }),
        transport,
      );

      await expect(firstPublisher.publishNext()).rejects.toMatchObject({
        code: "23514",
        constraint: "outbox_publish_test_failure",
      });
    } finally {
      await orm.em.fork().execute(`
        alter table "${schema}".outbox_messages
        drop constraint outbox_publish_test_failure
      `);
    }

    // O SQS confirmou o envio antes de o banco rejeitar a atualização.
    expect(acceptedIds).toEqual([record.id]);

    const pending = await orm.em
      .fork({ schema })
      .findOneOrFail(OutboxMessageRecord, { id: record.id });

    expect(pending.publishedAt).toBeNull();
    expect(pending.nextAttemptAt).toBeNull();
    expect(pending.attempts).toBe(0);
    expect(pending.payload).toEqual(record.payload);

    // Uma nova instância recupera o evento diretamente do banco.
    const restartedPublisher = new PostgresOutboxPublisher(
      orm.em.fork({ schema }),
      transport,
    );

    expect(await restartedPublisher.publishNext()).toMatchObject({
      status: "PUBLISHED",
      eventId: record.id,
    });

    // As duas chamadas enviaram o mesmo ID ao SQS.
    expect(acceptedIds).toEqual([record.id, record.id]);

    const published = await orm.em
      .fork({ schema })
      .findOneOrFail(OutboxMessageRecord, { id: record.id });

    expect(published.publishedAt).not.toBeNull();
    expect(published.payload).toEqual(record.payload);

    const received = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["MessageDeduplicationId"],
      }),
    );

    const message = received.Messages?.[0];

    if (
      message === undefined ||
      message.Body === undefined ||
      message.ReceiptHandle === undefined
    ) {
      throw new Error("Evento não foi recebido após a recuperação.");
    }

    expect(JSON.parse(message.Body)).toEqual(record.payload);
    expect(message.Attributes?.MessageDeduplicationId).toBe(record.id);

    await client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );

    expect(await orm.em.fork({ schema }).count(OutboxMessageRecord, {})).toBe(
      1,
    );

    expect((await restartedPublisher.publishNext()).status).toBe("IDLE");
  });
}, 20_000);

test("erro real do SQS persiste o agendamento de retry", async () => {
  await withSqsQueue(async (client, queueUrl) => {
    const record = await seedOutbox();
    const before = Date.now();

    const missingQueueUrl = queueUrl.replace(
      /[^/]+$/,
      `missing-${crypto.randomUUID()}.fifo`,
    );

    const publisher = new PostgresOutboxPublisher(
      orm.em.fork({ schema }),
      new SqsEventPublisher(client, missingQueueUrl),
    );

    const result = await publisher.publishNext();

    expect(result.status).toBe("RETRY_SCHEDULED");

    if (result.status !== "RETRY_SCHEDULED") {
      throw new Error("Era esperado um agendamento de retry.");
    }

    expect(result.eventId).toBe(record.id);
    expect(result.error).toBeInstanceOf(Error);

    const stored = await orm.em
      .fork({ schema })
      .findOneOrFail(OutboxMessageRecord, { id: record.id });

    expect(stored.publishedAt).toBeNull();
    expect(stored.attempts).toBe(1);
    expect(stored.nextAttemptAt).not.toBeNull();
    expect(stored.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(
      before + 1_000,
    );
    expect(stored.payload).toEqual(record.payload);
  });
}, 20_000);

test("dois publishers concorrentes publicam eventos distintos no SQS", async () => {
  await withSqsQueue(async (client, queueUrl) => {
    const firstRecord = await seedOutbox();
    const secondRecord = await seedOutbox();

    const firstPublisher = new PostgresOutboxPublisher(
      orm.em.fork({ schema }),
      new SqsEventPublisher(client, queueUrl),
    );

    const secondPublisher = new PostgresOutboxPublisher(
      orm.em.fork({ schema }),
      new SqsEventPublisher(client, queueUrl),
    );

    const results = await Promise.all([
      firstPublisher.publishNext(),
      secondPublisher.publishNext(),
    ]);

    const publishedIds = results.map((result) => {
      expect(result.status).toBe("PUBLISHED");

      if (result.status !== "PUBLISHED") {
        throw new Error("Publisher não publicou o evento esperado.");
      }

      return result.eventId;
    });

    const expectedIds = [firstRecord.id, secondRecord.id].sort();

    expect(publishedIds.sort()).toEqual(expectedIds);

    const receivedIds: string[] = [];

    for (let attempt = 0; attempt < 4 && receivedIds.length < 2; attempt += 1) {
      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 2,
          WaitTimeSeconds: 1,
          MessageSystemAttributeNames: ["MessageDeduplicationId"],
        }),
      );

      for (const message of received.Messages ?? []) {
        if (message.Body === undefined || message.ReceiptHandle === undefined) {
          throw new Error("Mensagem recebida sem corpo ou receipt handle.");
        }

        const payload = JSON.parse(message.Body) as Record<string, unknown>;
        const eventId = payload.eventId;

        if (typeof eventId !== "string") {
          throw new Error("Evento recebido sem eventId válido.");
        }

        expect(message.Attributes?.MessageDeduplicationId).toBe(eventId);

        receivedIds.push(eventId);

        await client.send(
          new DeleteMessageCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
    }

    expect(receivedIds.sort()).toEqual(expectedIds);

    const stored = await orm.em.fork({ schema }).find(OutboxMessageRecord, {});

    expect(stored).toHaveLength(2);
    expect(stored.every((record) => record.publishedAt !== null)).toBe(true);

    expect((await firstPublisher.publishNext()).status).toBe("IDLE");
  });
}, 20_000);

function startOutboxWorker(queueUrl: string) {
  const queueName = new URL(queueUrl).pathname.split("/").at(-1);

  if (!queueName) {
    throw new Error("URL da fila de teste inválida.");
  }

  const workerPath = fileURLToPath(
    new URL("../../src/workers/outbox-worker.ts", import.meta.url),
  );

  const worker = Bun.spawn([process.execPath, workerPath], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DATABASE_SCHEMA: schema,
      SQS_EVENTS_QUEUE_NAME: queueName,
    },
    timeout: 15_000,
    killSignal: "SIGKILL",
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
    stdout,
    stderr: new Response(worker.stderr).text(),
    output: () => output,
  };
}

type OutboxWorkerHandle = ReturnType<typeof startOutboxWorker>;

async function waitForWorkerEvent(
  handle: OutboxWorkerHandle,
  event: string,
): Promise<void> {
  await withDeadline(
    (async () => {
      while (!handle.output().includes(`"event":"${event}"`)) {
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

async function cleanupOutboxWorker(handle: OutboxWorkerHandle): Promise<void> {
  if (handle.worker.exitCode === null && handle.worker.signalCode === null) {
    handle.worker.kill("SIGKILL");
  }

  await Promise.allSettled([
    handle.worker.exited,
    handle.stdout,
    handle.stderr,
  ]);
}

test("worker real encerra normalmente ao receber SIGTERM", async () => {
  await withSqsQueue(async (_client, queueUrl) => {
    const handle = startOutboxWorker(queueUrl);

    try {
      await waitForWorkerEvent(handle, "outbox_worker_ready");

      expect(handle.worker.pid).not.toBe(process.pid);
      expect(handle.worker.exitCode).toBeNull();

      handle.worker.kill("SIGTERM");

      expect(await withDeadline(handle.worker.exited)).toBe(0);

      const output = await handle.stdout;

      expect(output).toContain('"event":"outbox_worker_stopping"');
      expect(output).toContain('"event":"outbox_worker_stopped"');
      expect(output).not.toContain('"event":"outbox_worker_failed"');
    } finally {
      await cleanupOutboxWorker(handle);
    }
  });
}, 20_000);

test("novo worker publica evento confirmado antes da queda do anterior", async () => {
  await withSqsQueue(async (client, queueUrl) => {
    const record = await seedOutbox();

    const firstPid = await orm.em.fork({ schema }).transactional(async (em) => {
      await em.findOneOrFail(
        OutboxMessageRecord,
        { id: record.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      const first = startOutboxWorker(queueUrl);

      try {
        await waitForWorkerEvent(first, "outbox_worker_ready");

        first.worker.kill("SIGKILL");
        await withDeadline(first.worker.exited);

        expect(first.worker.signalCode).toBe("SIGKILL");
        expect(await first.stdout).not.toContain(
          '"event":"outbox_event_published"',
        );

        return first.worker.pid;
      } finally {
        await cleanupOutboxWorker(first);
      }
    });

    const pending = await orm.em
      .fork({ schema })
      .findOneOrFail(OutboxMessageRecord, { id: record.id });

    expect(pending.publishedAt).toBeNull();
    expect(pending.payload).toEqual(record.payload);

    const second = startOutboxWorker(queueUrl);

    try {
      await waitForWorkerEvent(second, "outbox_event_published");

      expect(second.worker.pid).not.toBe(firstPid);

      const published = await orm.em
        .fork({ schema })
        .findOneOrFail(OutboxMessageRecord, { id: record.id });

      expect(published.publishedAt).not.toBeNull();
      expect(published.payload).toEqual(record.payload);

      const received = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ["MessageDeduplicationId"],
        }),
      );

      const message = received.Messages?.[0];

      if (
        message === undefined ||
        message.Body === undefined ||
        message.ReceiptHandle === undefined
      ) {
        throw new Error("Evento não foi recebido após reiniciar o worker.");
      }

      expect(JSON.parse(message.Body)).toEqual(record.payload);
      expect(message.Attributes?.MessageDeduplicationId).toBe(record.id);

      await client.send(
        new DeleteMessageCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );

      second.worker.kill("SIGTERM");

      expect(await withDeadline(second.worker.exited)).toBe(0);
      expect(await second.stdout).toContain('"event":"outbox_worker_stopped"');
    } finally {
      await cleanupOutboxWorker(second);
    }
  });
}, 30_000);
