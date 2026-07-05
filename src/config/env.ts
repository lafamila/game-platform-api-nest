export function env(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`${key} is required`);
}

export function hasEnv(key: string): boolean {
  const value = process.env[key];
  return value !== undefined && value !== '';
}

export function intEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be an integer`);
  }
  return parsed;
}

export function listEnv(key: string, fallback = ''): string[] {
  return env(key, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
