import { MikroORM } from "@mikro-orm/postgresql";
import { Money } from "../../src/domain/money";
import type { MoneyProps } from "../../src/domain/money";
import config from "../../src/infrastructure/database/mikro-orm.config";
import { PostgresWagerProcessor } from "../../src/infrastructure/database/postgres-wager-processor";
import type {
  ProcessWagerProps,
  PostgresWagerResult,
} from "../../src/infrastructure/database/postgres-wager-processor";

type SerializedWager = Omit<ProcessWagerProps, "money"> & {
  money: MoneyProps;
};

export interface WagerWorkerOutput {
  pid: number;
  result: PostgresWagerResult;
}

async function main(): Promise<void> {
  const schema = process.argv[2];

  if (!schema) {
    throw new Error("Informe o schema temporário do teste.");
  }

  const incoming = new Promise<unknown>((resolve) => {
    process.once("message", (message: unknown) => {
      resolve(message);
    });
  });

  const orm = await MikroORM.init(config);

  try {
    await orm.connect();

    if (process.send === undefined) {
      throw new Error("Este helper precisa de um canal IPC.");
    }

    process.send("ready");

    const message = await incoming;

    if (typeof message !== "string") {
      throw new Error("Mensagem de teste inválida.");
    }

    const input = JSON.parse(message) as SerializedWager;

    const processor = new PostgresWagerProcessor(orm.em.fork({ schema }));

    const result = await processor.process({
      ...input,
      money: Money.from(input.money),
    });

    const output: WagerWorkerOutput = {
      pid: process.pid,
      result,
    };

    console.log(JSON.stringify(output));
  } finally {
    await orm.close(true);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    process.disconnect?.();
  });
