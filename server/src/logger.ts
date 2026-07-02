// Logger mínimo com timestamp. Mensagens em português.
function ts(): string {
  return new Date().toISOString();
}

export const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}]`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] AVISO`, ...a),
  error: (...a: unknown[]) => console.error(`[${ts()}] ERRO`, ...a),
};
