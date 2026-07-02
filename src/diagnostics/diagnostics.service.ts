import { Injectable } from '@nestjs/common';
import { AuthAccount } from '../auth/auth.types';
import { DatabaseService } from '../database/database.service';

interface ClientErrorInput {
  method?: unknown;
  path?: unknown;
  statusCode?: unknown;
  message?: unknown;
  context?: unknown;
  occurredAt?: unknown;
}

@Injectable()
export class DiagnosticsService {
  constructor(private readonly db: DatabaseService) {}

  async saveClientErrors(user: AuthAccount, body: { errors?: unknown[] }) {
    const errors = Array.isArray(body.errors) ? body.errors.slice(0, 50) as ClientErrorInput[] : [];
    for (const error of errors) {
      await this.db.query(
        `INSERT INTO client_error_reports
         (account_id, method, path, status_code, message, context_json, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [
          user.accountId,
          truncate(error.method, 16),
          truncate(error.path, 240),
          statusCode(error.statusCode),
          truncate(error.message, 2000),
          JSON.stringify(safeContext(error.context)),
          occurredAt(error.occurredAt),
        ],
      );
    }
    return { saved: errors.length };
  }
}

function truncate(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function statusCode(value: unknown): number | null {
  const code = Number(value);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
}

function occurredAt(value: unknown): Date {
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function safeContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
