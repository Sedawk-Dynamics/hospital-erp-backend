import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authController, signInFailure } from '../../../../src/modules/auth/auth.controller';
import { authService } from '../../../../src/modules/auth/auth.service';
import { AppError } from '../../../../src/shared/appError';

// Gap 371: a fault inside sign-in reached the user as a bare 500 "Internal
// server error". Expected refusals must still pass through untouched.
describe('auth controller — sign-in failures', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('turns an unexpected login error into a controlled 503', async () => {
    vi.spyOn(authService, 'login').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const next = vi.fn();

    await authController.login({ body: { email: 'a@b.com', password: 'x' } } as never, {} as never, next);

    const err = next.mock.calls[0]![0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe('SIGNIN_UNAVAILABLE');
    expect(err.message).toBe('Sign-in is temporarily unavailable. Try again in a few minutes.');
  });

  it('passes a wrong-password 401 through unchanged', async () => {
    const refusal = AppError.unauthorized('Invalid credentials');
    vi.spyOn(authService, 'login').mockRejectedValue(refusal);
    const next = vi.fn();

    await authController.login({ body: { email: 'a@b.com', password: 'x' } } as never, {} as never, next);

    expect(next).toHaveBeenCalledWith(refusal);
  });

  it('leaves validation errors for the error handler', () => {
    const zodLike = Object.assign(new Error('bad'), { name: 'ZodError' });
    expect(signInFailure(zodLike, 'password')).toBe(zodLike);
  });
});
