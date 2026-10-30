export interface HttpRequestContext {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  walletId?: string;
  providerId?: string;
  transactionId?: string;
}
