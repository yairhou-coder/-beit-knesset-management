/** שגיאות אפליקטיביות עם קוד HTTP, כדי שהראוטרים לא יצטרכו למפות שגיאות ידנית. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'bad_request',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} לא נמצא`, 404, 'not_found');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, 'validation_error', details);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'conflict', details);
    this.name = 'ConflictError';
  }
}
