import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
	InteractionProtocol,
	parseInteractionProtocolRequest,
	type BeeMaxRuntimeSource,
	type InteractionScope,
} from "@beemax/core";

const MAX_BODY_BYTES = 128 * 1024;

export interface InteractionControlServerOptions<Source extends BeeMaxRuntimeSource> {
	protocol: InteractionProtocol<Source>;
	/** Maps a bearer credential to its exact authorized scope; never return a broader scope. */
	authenticate(request: IncomingMessage): Promise<InteractionScope | undefined> | InteractionScope | undefined;
	host?: "127.0.0.1" | "::1";
	port?: number;
}

/** Local-only HTTP transport for the Core interaction control protocol. */
export class InteractionControlServer<Source extends BeeMaxRuntimeSource> {
	private readonly options: Required<Pick<InteractionControlServerOptions<Source>, "host" | "port">> & InteractionControlServerOptions<Source>;
	private server?: Server;

	constructor(options: InteractionControlServerOptions<Source>) {
		this.options = { ...options, host: options.host ?? "127.0.0.1", port: options.port ?? 0 };
	}

	async listen(): Promise<{ host: string; port: number }> {
		if (this.server) throw new Error("Interaction control server is already listening");
		this.server = createServer((request, response) => { void this.handle(request, response); });
		await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(this.options.port, this.options.host, resolve));
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Interaction control server did not expose a TCP address");
		return { host: address.address, port: address.port };
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (request.method !== "POST" || request.url !== "/v1/interaction") return this.respond(response, 404, { error: "not_found" });
		const scope = await this.options.authenticate(request);
		if (!scope) return this.respond(response, 401, { error: "unauthorized" });
		const body = await readJson(request).catch(() => undefined);
		const parsed = parseInteractionProtocolRequest(body);
		if (!parsed) return this.respond(response, 400, { error: "invalid_request" });
		const result = await this.options.protocol.handle(parsed, scope);
		return this.respond(response, result.ok ? 200 : result.error === "unauthorized_scope" ? 403 : 400, result);
	}

	private respond(response: ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify(body));
	}
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	let bytes = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
