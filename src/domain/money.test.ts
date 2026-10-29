import { expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidMoneyError,
  Money,
} from './money';

test('cria e serializa um valor em BRL', () => {
  const money = Money.from({
    amount: '25.00',
    currency: 'BRL',
  });

  expect(money.toJSON()).toEqual({
    amount: '25.00',
    currency: 'BRL',
  });
});

test('aceita saldo zero', () => {
  const money = Money.from({
    amount: '0.00',
    currency: 'BRL',
  });

  expect(money.toJSON().amount).toBe('0.00');
});

test('preserva os centavos de um valor grande', () => {
  const amount = '9007199254740993.01';

  const money = Money.from({ amount, currency: 'BRL' });

  expect(money.toJSON().amount).toBe(amount);
});

test.each([
  '',
  '25',
  '25.0',
  '25.001',
  '-25.00',
  'NaN',
  'Infinity',
  '1e2',
  '25,00',
  ' 25.00',
  '25.00\n',
  '025.00',
])('rejeita o valor inválido "%s"', (amount) => {
  expect(() =>
    Money.from({ amount, currency: 'BRL' }),
  ).toThrow(InvalidMoneyError);
});

test('rejeita moeda não suportada', () => {
  expect(() =>
    Money.from({ amount: '25.00', currency: 'XYZ' }),
  ).toThrow(InvalidMoneyError);
});


test('soma centavos sem alterar os objetos originais', () => {
  const a = Money.from({ amount: '0.10', currency: 'BRL' });
  const b = Money.from({ amount: '0.20', currency: 'BRL' });

  const result = a.add(b);

  expect(result.toJSON().amount).toBe('0.30');
  expect(a.toJSON().amount).toBe('0.10');
  expect(b.toJSON().amount).toBe('0.20');
  expect(result).not.toBe(a);
  expect(result).not.toBe(b);
});

test('subtrai e permite resultado negativo interno', () => {
  const a = Money.from({ amount: '10.00', currency: 'BRL' });
  const b = Money.from({ amount: '15.00', currency: 'BRL' });

  const result = a.subtract(b);

  expect(result.toJSON().amount).toBe('-5.00');
  expect(a.toJSON().amount).toBe('10.00');
  expect(b.toJSON().amount).toBe('15.00');
});

test('compara pelo valor e não pela identidade do objeto', () => {
  const a = Money.from({ amount: '25.00', currency: 'BRL' });
  const b = Money.from({ amount: '25.00', currency: 'BRL' });
  const c = Money.from({ amount: '30.00', currency: 'BRL' });

  expect(a).not.toBe(b);
  expect(a.equals(b)).toBe(true);
  expect(a.equals(c)).toBe(false);
});

test('rejeita operações entre moedas diferentes', () => {
  const brl = Money.from({ amount: '10.00', currency: 'BRL' });
  const usd = Money.from({ amount: '10.00', currency: 'USD' });

  expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  expect(() => brl.subtract(usd)).toThrow(CurrencyMismatchError);
  expect(() => brl.equals(usd)).toThrow(CurrencyMismatchError);
});

test('preserva um centavo próximo ao limite monetário', () => {
  const a = Money.from({
    amount: '999999999999999999.98',
    currency: 'BRL',
  });
  const cent = Money.from({ amount: '0.01', currency: 'BRL' });

  expect(a.add(cent).toJSON().amount)
    .toBe('999999999999999999.99');
});

test('rejeita entrada e resultado acima do limite monetário', () => {
  expect(() =>
    Money.from({
      amount: '1000000000000000000.00',
      currency: 'BRL',
    }),
  ).toThrow(InvalidMoneyError);

  const maximum = Money.from({
    amount: '999999999999999999.99',
    currency: 'BRL',
  });
  const cent = Money.from({ amount: '0.01', currency: 'BRL' });

  expect(() => maximum.add(cent)).toThrow(InvalidMoneyError);
});


test('cria zero na moeda informada e valida a moeda', () => {
  expect(Money.zero('USD').toJSON()).toEqual({
    amount: '0.00',
    currency: 'USD',
  });

  expect(() => Money.zero('XYZ')).toThrow(InvalidMoneyError);
});

test('inverte o sinal sem alterar o objeto original', () => {
  const original = Money.from({
    amount: '25.00',
    currency: 'BRL',
  });

  const negative = original.negate();

  expect(negative.toJSON()).toEqual({
    amount: '-25.00',
    currency: 'BRL',
  });
  expect(original.toJSON().amount).toBe('25.00');
  expect(negative).not.toBe(original);
  expect(negative.negate().equals(original)).toBe(true);
});

test('inverter o sinal de zero mantém sua representação', () => {
  const result = Money.zero('BRL').negate();

  expect(result.toString()).toBe('0.00');
  expect(result.isZero()).toBe(true);
  expect(result.isPositive()).toBe(false);
  expect(result.isNegative()).toBe(false);
});

test('identifica valores positivos, negativos e zero', () => {
  const positive = Money.from({
    amount: '10.00',
    currency: 'BRL',
  });
  const negative = positive.negate();
  const zero = Money.zero('BRL');

  expect(positive.isPositive()).toBe(true);
  expect(positive.isNegative()).toBe(false);
  expect(positive.isZero()).toBe(false);

  expect(negative.isPositive()).toBe(false);
  expect(negative.isNegative()).toBe(true);
  expect(negative.isZero()).toBe(false);

  expect(zero.isPositive()).toBe(false);
  expect(zero.isNegative()).toBe(false);
  expect(zero.isZero()).toBe(true);
});

test('compara a ordem dos valores e rejeita moedas diferentes', () => {
  const smaller = Money.from({
    amount: '10.00',
    currency: 'BRL',
  });
  const larger = Money.from({
    amount: '20.00',
    currency: 'BRL',
  });
  const usd = Money.from({
    amount: '10.00',
    currency: 'USD',
  });

  expect(smaller.isLessThan(larger)).toBe(true);
  expect(larger.isLessThan(smaller)).toBe(false);
  expect(smaller.isLessThan(smaller)).toBe(false);
  expect(smaller.negate().isLessThan(smaller)).toBe(true);

  expect(() => smaller.isLessThan(usd))
    .toThrow(CurrencyMismatchError);
});

test('converter valores para texto com duas casas decimais', () => {
  const money = Money.from({
    amount: '25.00',
    currency: 'BRL',
  });

  expect(money.toString()).toBe('25.00');
  expect(money.negate().toString()).toBe('-25.00');
});

test('rejeitar resultado abaixo do limite monetário negativo', () => {
  const minimum = Money.from({
    amount: '999999999999999999.99',
    currency: 'BRL',
  }).negate();

  const cent = Money.from({
    amount: '0.01',
    currency: 'BRL',
  });

  expect(() => minimum.subtract(cent))
    .toThrow(InvalidMoneyError);
});