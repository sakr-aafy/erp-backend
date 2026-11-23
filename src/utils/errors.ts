export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
  }
  static badRequest(m: string, details?: unknown) { return new AppError(400, m, 'BAD_REQUEST', details); }
  static unauthorized(m = 'Authentification requise') { return new AppError(401, m, 'UNAUTHORIZED'); }
  static forbidden(m = 'Accès refusé') { return new AppError(403, m, 'FORBIDDEN'); }
  static notFound(m = 'Ressource introuvable') { return new AppError(404, m, 'NOT_FOUND'); }
  static conflict(m: string) { return new AppError(409, m, 'CONFLICT'); }
}
