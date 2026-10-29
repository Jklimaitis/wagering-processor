import { Migration } from "@mikro-orm/migrations";

export class Migration20261029000500 extends Migration {
  override up(): void {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash text not null,
        received_at timestamptz not null,
        processed_at timestamptz,

        constraint inbox_messages_pkey
          primary key (consumer_name, message_id),

        constraint inbox_messages_required_values
          check (
            length(trim(consumer_name)) > 0
            and length(trim(message_id)) > 0
            and length(trim(payload_hash)) > 0
          )
      );
    `);
  }

  override down(): void {
    this.addSql("drop table inbox_messages;");
  }
}
