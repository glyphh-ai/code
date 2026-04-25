/**
 * reflex.retry — semantic backoff on failure.
 *
 * Strategy ladder (each step tried at most once):
 *   1. Same call, augmented hint
 *   2. Switch to a fallback (different skill / model)
 *   3. Ask the user
 *
 * After all three steps, the original error is re-thrown.
 */

export interface RetryStrategy<T> {
  /** Step 1: re-run with augmented hint. Receives the prior error message as hint. */
  augment?: (hint: string) => Promise<T>;
  /** Step 2: switch to a fallback path entirely. */
  fallback?: () => Promise<T>;
  /** Step 3: surface to user, return their answer wrapped as T (or null to give up). */
  askUser?: () => Promise<T | null>;
}

export async function reflexRetry<T>(
  primary: () => Promise<T>,
  strategy: RetryStrategy<T> = {},
): Promise<T> {
  let lastErr: Error | null = null;

  try {
    return await primary();
  } catch (err) {
    lastErr = err instanceof Error ? err : new Error(String(err));
  }

  if (strategy.augment) {
    try {
      return await strategy.augment(lastErr.message);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (strategy.fallback) {
    try {
      return await strategy.fallback();
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (strategy.askUser) {
    try {
      const result = await strategy.askUser();
      if (result !== null) return result;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastErr;
}
