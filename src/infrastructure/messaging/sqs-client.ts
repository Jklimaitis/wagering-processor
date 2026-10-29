import { SQSClient } from "@aws-sdk/client-sqs";

function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória: ${name}`);
  }

  return value;
}

export function createSqsClient(): SQSClient {
  return new SQSClient({
    endpoint: requiredEnvironment("AWS_ENDPOINT_URL"),
    region: requiredEnvironment("AWS_REGION"),
    credentials: {
      accessKeyId: requiredEnvironment("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnvironment("AWS_SECRET_ACCESS_KEY"),
    },
    useQueueUrlAsEndpoint: false,
    maxAttempts: 1,
  });
}
