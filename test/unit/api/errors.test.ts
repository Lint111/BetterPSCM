import { describe, it, expect } from 'vitest';
import {
	PlasticApiError,
	AuthExpiredError,
	NotFoundError,
	ConflictError,
	ConnectionError,
	isPlasticApiError,
} from '../../../src/api/errors';

describe('API Errors', () => {
	describe('PlasticApiError', () => {
		it('stores status code and key message', () => {
			const err = new PlasticApiError('Bad request', 400, 'INVALID_INPUT');
			expect(err.message).toBe('Bad request');
			expect(err.statusCode).toBe(400);
			expect(err.keyMessage).toBe('INVALID_INPUT');
			expect(err.name).toBe('PlasticApiError');
		});

		it('is an instance of Error', () => {
			const err = new PlasticApiError('fail', 500);
			expect(err).toBeInstanceOf(Error);
		});
	});

	describe('AuthExpiredError', () => {
		it('defaults to 401 with standard message', () => {
			const err = new AuthExpiredError();
			expect(err.statusCode).toBe(401);
			expect(err.message).toBe('Authentication token expired');
			expect(err.name).toBe('AuthExpiredError');
		});

		it('accepts custom message', () => {
			const err = new AuthExpiredError('Custom auth error');
			expect(err.message).toBe('Custom auth error');
		});
	});

	describe('NotFoundError', () => {
		it('defaults to 404', () => {
			const err = new NotFoundError();
			expect(err.statusCode).toBe(404);
			expect(err.name).toBe('NotFoundError');
		});
	});

	describe('ConflictError', () => {
		it('defaults to 409', () => {
			const err = new ConflictError();
			expect(err.statusCode).toBe(409);
			expect(err.name).toBe('ConflictError');
		});
	});

	describe('ConnectionError', () => {
		it('includes server URL in message', () => {
			const err = new ConnectionError('https://example.com');
			expect(err.message).toContain('https://example.com');
			expect(err.serverUrl).toBe('https://example.com');
			expect(err.name).toBe('ConnectionError');
		});

		it('stores cause error', () => {
			const cause = new Error('ECONNREFUSED');
			const err = new ConnectionError('https://example.com', cause);
			expect(err.cause).toBe(cause);
		});
	});

	describe('isPlasticApiError', () => {
		it('returns true for PlasticApiError instances', () => {
			expect(isPlasticApiError(new PlasticApiError('x', 400))).toBe(true);
			expect(isPlasticApiError(new AuthExpiredError())).toBe(true);
			expect(isPlasticApiError(new NotFoundError())).toBe(true);
		});

		it('returns false for non-PlasticApiError', () => {
			expect(isPlasticApiError(new Error('x'))).toBe(false);
			expect(isPlasticApiError(null)).toBe(false);
			expect(isPlasticApiError('string')).toBe(false);
		});
	});
});
