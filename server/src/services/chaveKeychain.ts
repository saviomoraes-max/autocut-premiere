// Chave de API lida do Keychain do macOS (23/set/2026).
//
// Por que: chave em arquivo `.env` vaza fácil — num backup, num `cat` distraído, num print de
// tela. No Keychain ela fica cifrada com a conta do usuário e o LaunchAgent do backend consegue
// ler sem pedir senha (testado com a chave do ElevenLabs em 21/09).
//
// A chave fica só em memória: nunca é impressa, nunca volta numa mensagem de erro.
import { execFile } from "node:child_process";

const cache = new Map<string, string>();

/** Lê a senha genérica do Keychain. Devolve "" se não existir (quem chama decide o fallback). */
export function lerChaveDoKeychain(servico: string): Promise<string> {
  const guardada = cache.get(servico);
  if (guardada) return Promise.resolve(guardada);
  return new Promise((resolve) => {
    execFile("/usr/bin/security", ["find-generic-password", "-s", servico, "-w"], { timeout: 15000 }, (err, stdout) => {
      // stdout NUNCA entra em log/erro: se vier algo, é a própria chave.
      const chave = (stdout ?? "").trim();
      if (err || !chave) {
        resolve("");
        return;
      }
      cache.set(servico, chave);
      resolve(chave);
    });
  });
}
