import Decimal from 'decimal.js';

const MoneyDecimal = Decimal.clone({ precision: 40 });

const MAX_AMOUNT = new MoneyDecimal('999999999999999999.99');


export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMoneyError';
  }
}


export class CurrencyMismatchError extends Error {
  constructor() {
    super('Não é possível operar com moedas diferentes.');
    this.name = 'CurrencyMismatchError';
  }
}


export class Money {
  private constructor(
  private readonly value: Decimal,
  public readonly currency: string,
) {
  if (value.abs().greaterThan(MAX_AMOUNT)) {
    throw new InvalidMoneyError('Valor fora do limite monetário.');
  }
}

  static from(props: MoneyProps): Money {
    const { amount, currency } = props;

    const validAmount =
      typeof amount === 'string' &&
      amount.trim() === amount &&
      /^(0|[1-9][0-9]*)\.[0-9]{2}$/.test(amount);

    if (!validAmount) {
      throw new InvalidMoneyError(
        'O valor deve ser uma string não negativa com duas casas decimais.',
      );
    }

    // Lista inicial de moedas suportadas pelo objeto.
    if (currency !== 'BRL' && currency !== 'USD') {
      throw new InvalidMoneyError('Moeda não suportada.');
    }

    return new Money(new MoneyDecimal(amount), currency);
  }


  add(other: Money): Money {
  this.assertSameCurrency(other);

  return new Money(
    this.value.plus(other.value),
    this.currency,
  );
}

subtract(other: Money): Money {
  this.assertSameCurrency(other);

  return new Money(
    this.value.minus(other.value),
    this.currency,
  );
}

equals(other: Money): boolean {
  this.assertSameCurrency(other);

  return this.value.equals(other.value);
}

private assertSameCurrency(other: Money): void {
  if (this.currency !== other.currency) {
    throw new CurrencyMismatchError();
  }
}


static zero(currency: string): Money {
  return Money.from({
    amount: '0.00',
    currency,
  });
}

negate(): Money {
  return new Money(
    this.value.negated(),
    this.currency,
  );
}

isZero(): boolean {
  return this.value.isZero();
}

isPositive(): boolean {
  return this.value.greaterThan('0');
}

isNegative(): boolean {
  return this.value.lessThan('0');
}

isLessThan(other: Money): boolean {
  this.assertSameCurrency(other);

  return this.value.lessThan(other.value);
}

toString(): string {
  return this.value.toFixed(2); // Aqui mantenho 2 casas decimais e devolvo apenas o valor como 25.00
}

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }
}