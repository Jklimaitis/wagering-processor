# Wagering Processor

Implementação do [desafio backend da Jungle Gaming](https://github.com/junglegaming/backend-challenge).
Processamento financeiro por HTTP e SQS, com PostgreSQL como autoridade para saldo,
idempotência, concorrência, ledger e recuperação após falhas.

Stack: Bun 1.4.4, TypeScript estrito, NestJS, MikroORM 7.2.0, PostgreSQL 16,
LocalStack 3 e Docker Compose. Decisões e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Executar com Docker

Requisito: Docker com Compose v2 e suporte a `--wait`.

```bash
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
curl -sS http://localhost:3000/health/ready
```

O serviço `setup` aguarda PostgreSQL e LocalStack saudáveis, aplica as migrations e
cria as filas. API e workers iniciam depois que ele termina com sucesso. A configuração
local do Compose já contém os valores necessários; não precisa criar `.env` nesse modo.
`API_PORT=3010 docker compose up -d` altera a porta HTTP publicada no host.

| Serviço | Acesso |
|---|---|
| API e métricas HTTP | `http://localhost:3000`, `/metrics` |
| PostgreSQL | `localhost:15433`, banco/usuário/senha locais `wagering` |
| LocalStack | `http://localhost:4566` |
| Filas | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo` |
| Métricas de cada worker | Porta dinâmica do host, porta interna `3001` |

As portas dinâmicas dos workers permitem múltiplas instâncias sem colisão:

```bash
docker compose up -d --scale wager-worker=3
docker compose port --index 1 wager-worker 3001
docker compose port outbox-worker 3001
curl "http://$(docker compose port outbox-worker 3001)/metrics"
docker compose logs --tail=20 api wager-worker outbox-worker reference-worker
```

Encerramento gracioso: `docker compose stop`. Os dados do PostgreSQL ficam no volume
`pgdata`. O LocalStack desta configuração é efêmero; após recriá-lo, execute
`docker compose run --rm setup` para recriar as filas. Reiniciar um worker não remove filas.

## Validar a entrega

```bash
# Typecheck e todos os testes, dentro da imagem, com PostgreSQL e SQS reais.
docker compose run --rm --no-deps tests

# Verifica os processos do Compose trabalhando juntos.
docker compose run --rm --no-deps tests bun run verify:compose
```

A verificação do Compose cria dados identificados por UUID: wallet com abertura,
BET HTTP e replay, WIN entregue duas vezes via SQS, REFUND antes da BET referenciada,
reprocessamento pelo worker, reconciliação e confirmação da publicação dos eventos.
O resultado esperado é `compose_verification_passed`. Os registros financeiros de
verificação permanecem no banco, respeitando a imutabilidade do ledger.

Os testes usam schemas e filas exclusivos, removidos ao final. A suíte inclui as
50 requisições idênticas concorrentes, disputa de saldo, wallets independentes,
três processos, morte depois do commit e antes do ack, publishers concorrentes,
retry/DLQ, referências fora de ordem e migrations reversíveis.

## Desenvolvimento fora do Docker

Requisito adicional: Bun 1.4.4.

```bash
cp .env.example .env
bun install --frozen-lockfile
docker compose up -d --wait --wait-timeout 120 postgres localstack
bun run setup
bun run check
```

Abra terminais separados:

```bash
bun run start:dev
bun run worker:wagers
bun run worker:outbox
bun run worker:references
```

O Bun carrega `.env` automaticamente. Cada worker local informa `metricsPort` no log
de inicialização; `METRICS_PORT=3011 bun run worker:wagers` fixa essa porta.
As instâncias locais e do Compose podem compartilhar o banco e as filas; para
observar somente uma delas, pare a outra com `docker compose stop api wager-worker outbox-worker reference-worker`.

Comandos de banco: `bun run db:check`, `bun run db:up`, `bun run db:list`.
As seis migrations têm `up`/`down`; a suíte comprova rollback e reaplicação em schemas
isolados. Reverter migrations que criam tabelas apaga essas tabelas e exige planejamento
fora do ambiente de teste.

## Contrato HTTP

| Método e rota | Resultado |
|---|---|
| `POST /wallets` | Wallet; saldo positivo cria OPENING + ledger + eventos atomicamente |
| `GET /wallets/:walletId` | Saldo atual e versão |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | `{ items, nextCursor }` |
| `POST /wagering/transactions` | Resultado financeiro; exige `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | Transação e saldo observado no processamento |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Mesma consulta pela chave do provedor |
| `POST /wallets/:walletId/reconciliation` | Saldo armazenado, reconstruído, diferença e contagem |
| `GET /health/live` | Processo vivo |
| `GET /health/ready` | PostgreSQL e três filas acessíveis |
| `GET /metrics` | Métricas Prometheus da instância HTTP |

Exemplo de criação (repetir o mesmo jogador/moeda retorna `409`):

```bash
curl -sS -X POST http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Para apostar, substitua `WALLET_UUID` pelo `id` retornado:

```bash
curl -sS -X POST http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -H 'X-Correlation-Id: example-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"WALLET_UUID","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

Dinheiro entra e sai como string decimal com duas casas. BRL e USD são suportados,
com uma wallet por jogador/moeda. `OPENING` é somente interno. REFUND/ROLLBACK
exigem `referenceExternalTransactionId`. Identificadores externos usados em URLs
devem ser codificados com `encodeURIComponent`.

| Situação | HTTP |
|---|---:|
| Wallet criada | 201 |
| Processada ou replay de processada | 200 |
| Pendente de referência | 202 |
| Entrada inválida | 400 |
| Recurso inexistente | 404 |
| Wallet duplicada ou conflito de idempotência | 409 |
| Rejeição de negócio, inclusive replay | 422 |
| Falha interna / transação FAILED consultada por POST | 500 |
| Infraestrutura temporariamente indisponível / readiness negativa | 503 |

Consultas encontradas retornam `200` mesmo se o estado da transação for REJECTED.
Erros de entrada/infraestrutura retornam `{ statusCode, code, message, correlationId }`
e, quando aplicável, `field`. Rejeições retornam o resultado persistido com `failureCode`.

O cursor é Base64URL versionado e vinculado à wallet. Ordenação crescente por
`(created_at, id)`, limite padrão 50 e máximo 100. Reenvie `nextCursor` sem interpretá-lo;
`null` indica o fim. Cada página é uma leitura atual, não um snapshot congelado de
toda a navegação; inserções posteriores à posição podem aparecer nas páginas seguintes.

## Observabilidade

Logs JSON carregam os identificadores disponíveis; inicialização e health não têm
uma transação associada. Payloads e saldos completos não são registrados.

| Métrica | Significado |
|---|---|
| `wagering_transaction_results_total{source,status}` | Resultados novos de processamento de apostas |
| `wagering_duplicates_total{source}` | Replays detectados |
| `wagering_processing_duration_seconds{source}` | Histograma de duração, incluindo espera no banco |
| `wagering_retries_total{source}` | Reagendamentos confirmados |
| `wagering_dlq_messages_total{reason}` | Encaminhamentos concluídos à DLQ |
| `wagering_lock_conflicts_total{source}` | Deadlock, lock timeout e falha de serialização |
| `wagering_outbox_lag_seconds` | Idade do evento não publicado mais antigo; coletado no worker da outbox |
| `wagering_reconciliations_total{result}` | Reconciliações consistentes/divergentes |

Contadores são por processo e reiniciam junto dele; medem observações operacionais,
não substituem auditoria financeira. Mudança de PENDING_REFERENCE para estado final
gera outra observação de status. OPENING é criação interna de wallet, fora do contador
de comandos de apostas. Esperas normais de lock aparecem na latência; o contador de
conflitos registra erros efetivos. Consulte o lag no endpoint do worker da outbox;
em várias réplicas, use `max`, pois observam o mesmo backlog.

Autenticação completa foi deliberadamente adiada conforme a seção 2 do desafio.
`ProviderIdentityGuard` é o ponto de extensão explícito. O desenho OIDC está em
[ARCHITECTURE.md](ARCHITECTURE.md).
