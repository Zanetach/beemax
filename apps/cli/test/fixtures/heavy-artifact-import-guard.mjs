const BLOCKED_ARTIFACT_MODULES = new Set([
	"@napi-rs/canvas",
	"pdfjs-dist/legacy/build/pdf.mjs",
]);

export async function resolve(specifier, context, nextResolve) {
	if (BLOCKED_ARTIFACT_MODULES.has(specifier)) {
		throw new Error(`Gateway cold import loaded PDF-only dependency: ${specifier}`);
	}
	return nextResolve(specifier, context);
}
