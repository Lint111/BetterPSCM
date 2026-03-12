export class PlasticApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly keyMessage?: string,
	) {
		super(message);
		this.name = 'PlasticApiError';
	}
}

export class AuthExpiredError extends PlasticApiError {
	constructor(message = 'Authentication token expired') {
		super(message, 401);
		this.name = 'AuthExpiredError';
	}
}

export class NotFoundError extends PlasticApiError {
	constructor(message = 'Resource not found') {
		super(message, 404);
		this.name = 'NotFoundError';
	}
}

export class ConflictError extends PlasticApiError {
	constructor(message = 'Conflict') {
		super(message, 409);
		this.name = 'ConflictError';
	}
}

export class ConnectionError extends Error {
	constructor(
		public readonly serverUrl: string,
		cause?: Error,
	) {
		super(`Failed to connect to Plastic SCM server at ${serverUrl}`);
		this.name = 'ConnectionError';
		this.cause = cause;
	}
}

export function isPlasticApiError(err: unknown): err is PlasticApiError {
	return err instanceof PlasticApiError;
}
