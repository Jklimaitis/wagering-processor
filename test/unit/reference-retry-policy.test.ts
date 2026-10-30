import { expect, test } from "bun:test";
import {
  MAX_REFERENCE_ATTEMPTS,
  planReferenceRetry,
} from "../../src/application/reference-retry-policy";
import { FailureCode } from "../../src/domain/wager-transaction";

const at = new Date("2026-10-29T21:00:00.000Z");

const backoffCases: Array<[number, number]> = [
  [0, 1_000],
  [1, 2_000],
  [2, 4_000],
  [3, 8_000],
  [4, 16_000],
  [5, 32_000],
  [6, 60_000],
  [9, 60_000],
];

test.each(backoffCases)(
  "agenda backoff após %s tentativas",
  (attempts, delayMs) => {
    const decision = planReferenceRetry(attempts, at);

    expect(decision.action).toBe("RETRY");

    if (decision.action !== "RETRY") {
      throw new Error("Era esperado um novo agendamento.");
    }

    expect(decision.nextAttemptAt.getTime()).toBe(at.getTime() + delayMs);
  },
);

test.each([10, 11])(
  "rejeita referência ainda indisponível após %s tentativas",
  (attempts) => {
    expect(MAX_REFERENCE_ATTEMPTS).toBe(10);

    expect(planReferenceRetry(attempts, at)).toEqual({
      action: "REJECT",
      failureCode: FailureCode.ReferenceNotFound,
    });
  },
);

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejeita contador inválido: %s",
  (attempts) => {
    expect(() => planReferenceRetry(attempts, at)).toThrow();
  },
);

test("rejeita data inválida", () => {
  expect(() => planReferenceRetry(0, new Date("invalid"))).toThrow();
});

test("cria uma data independente sem alterar a recebida", () => {
  const original = new Date(at.getTime());
  const decision = planReferenceRetry(0, original);

  if (decision.action !== "RETRY") {
    throw new Error("Era esperado um novo agendamento.");
  }

  decision.nextAttemptAt.setUTCFullYear(2030);

  expect(original.toISOString()).toBe("2026-10-29T21:00:00.000Z");
});
