export class FlutterPayError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class FlutterPayConfigError extends FlutterPayError {}

export class FlutterPayNetworkError extends FlutterPayError {
  readonly isTimeout: boolean;

  constructor(message: string, options?: { isTimeout?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.isTimeout = options?.isTimeout ?? false;
  }
}

export class FlutterPayApiError extends FlutterPayError {
  readonly status: number;
  readonly code: string;

  constructor(options: { status: number; code: string; message: string; cause?: unknown }) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.status = options.status;
    this.code = options.code;
  }
}

export class FlutterPayValidationError extends FlutterPayApiError {}

export class FlutterPayAuthenticationError extends FlutterPayApiError {}

export class FlutterPayNotFoundError extends FlutterPayApiError {}

export class FlutterPayConflictError extends FlutterPayApiError {}

export class FlutterPayRateLimitError extends FlutterPayApiError {
  readonly retryAfter: string | null;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    retryAfter?: string | null;
    cause?: unknown;
  }) {
    super(options);
    this.retryAfter = options.retryAfter ?? null;
  }
}

export class FlutterPayWebhookSignatureError extends FlutterPayError {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(reason, options);
    this.reason = reason;
  }
}
