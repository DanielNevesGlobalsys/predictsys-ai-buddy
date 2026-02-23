export async function extractErrorMessage(err: unknown): Promise<string> {
  if (typeof err === "string" && err.trim()) return err;

  if (err instanceof Error && err.message) return err.message;

  if (typeof Response !== "undefined" && err instanceof Response) {
    try {
      const body = await err.clone().json();
      const responseMessage =
        body?.message ||
        body?.error ||
        body?.error_description ||
        body?.details ||
        body?.hint ||
        body?.code;

      if (typeof responseMessage === "string" && responseMessage.trim()) {
        return responseMessage;
      }
    } catch {
      // ignore parse errors and fallback below
    }
    return `${err.status} ${err.statusText}`.trim();
  }

  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;

    const directMessage =
      e.message || e.error_description || e.details || e.hint || e.error || e.code;

    if (typeof directMessage === "string" && directMessage.trim()) {
      return directMessage;
    }

    try {
      const asJson = JSON.stringify(err);
      if (asJson && asJson !== "{}") return asJson;
    } catch {
      // ignore stringify errors
    }
  }

  return "Erro inesperado ao processar a operação.";
}
