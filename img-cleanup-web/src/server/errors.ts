/** 带 HTTP 状态码的业务错误，app.ts 统一转换为 JSON 响应。 */
export class HttpError extends Error {
	readonly status: number;
	constructor(
		status: number,
		message: string,
	) {
		super(message);
		this.status = status;
	}
}
