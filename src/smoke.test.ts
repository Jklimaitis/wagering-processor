import { SQL } from 'bun';
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { SQSClient, GetQueueUrlCommand, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand, PurgeQueueCommand } from '@aws-sdk/client-sqs';



const db = new SQL(process.env.DATABASE_URL!);
const sqs = new SQSClient({
  endpoint: process.env.AWS_ENDPOINT_URL,
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const QUEUE_NAME = process.env.SQS_QUEUE_NAME!;

beforeAll(async () => {
  for (const nome of [QUEUE_NAME, process.env.SQS_DLQ_NAME!]) {
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: nome }));
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
  }
});


async function esvaziarFila(queueUrl: string): Promise<void> {
  for (;;) {
    const lote = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );
    const mensagens = lote.Messages ?? [];
    if (mensagens.length === 0) return;

    for (const m of mensagens) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
}


test('postgres responde', async () => {
  const linhas = await db`select 1 as n`;

  expect(linhas.length).toBe(1);
  expect(linhas[0]!.n).toBe(1);
});


test('fila FIFO aceita e devolve mensagem', async () => {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
  const corpo = JSON.stringify({ messageId: 'msg-smoke', type: 'WagerTransactionRequested' });

  const envio = await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: corpo,
      MessageGroupId: 'smoke',
      MessageDeduplicationId: 'msg-smoke',
    }),
  );
  expect(envio.MessageId).toBeDefined();

  const recebido = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 2 }),
  );
  const mensagem = recebido.Messages?.[0];

  expect(mensagem?.Body).toBe(corpo);
  expect(mensagem?.ReceiptHandle).toBeDefined();

  await sqs.send(
    new DeleteMessageCommand({ QueueUrl, ReceiptHandle: mensagem!.ReceiptHandle! }),
  );
});


test('mesma deduplicacao nao enfileira copia', async () => {
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }));
  await esvaziarFila(QueueUrl!);

  const sufixo = crypto.randomUUID();
  const entrada = {
    QueueUrl,
    MessageBody: JSON.stringify({ messageId: `msg-dedup-${sufixo}`, type: 'WagerTransactionRequested' }),
    MessageGroupId: 'dedup',
    MessageDeduplicationId: `dedup-${sufixo}`,
  };

  const primeiro = await sqs.send(new SendMessageCommand(entrada));
  const segundo = await sqs.send(new SendMessageCommand(entrada));

  expect(segundo.MessageId).toBe(primeiro.MessageId!);

  const atributos = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }),
  );

  expect(atributos.Attributes?.ApproximateNumberOfMessages).toBe('1');
});

afterAll(async () => {
  await db.close();
  sqs.destroy();
});
