import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import {
  MikroORM,
  type EntityManager,
  type Options,
} from "@mikro-orm/postgresql";
import config from "./mikro-orm.config";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private orm: MikroORM | undefined;

  constructor(private readonly options: Options = config) {}

  async onModuleInit(): Promise<void> {
    const orm = await MikroORM.init(this.options);

    try {
      await orm.connect();
      this.orm = orm;
    } catch (error: unknown) {
      await orm.close(true);
      throw error;
    }
  }

  get em(): EntityManager {
    if (this.orm === undefined) {
      throw new Error("Banco ainda não inicializado.");
    }

    return this.orm.em.fork();
  }

  async onModuleDestroy(): Promise<void> {
    await this.orm?.close(true);
    this.orm = undefined;
  }
}
