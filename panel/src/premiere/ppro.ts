// Acesso à API do Premiere via UXP, tipado pelos tipos OFICIAIS @adobe/premierepro.
// O runtime vem do módulo "premierepro" (provido pelo UXP); os tipos vêm do pacote.
import type { premierepro, Project, TickTime } from "@adobe/premierepro";

export const ppro = require("premierepro") as premierepro;

/** Cria um TickTime a partir de segundos (clampando em 0). */
export function tt(seconds: number): TickTime {
  return ppro.TickTime.createWithSeconds(Math.max(0, seconds));
}

/** Projeto ativo, ou erro claro se não houver. (getActiveProject é async no UXP.) */
export async function requireActiveProject(): Promise<Project> {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new Error("Nenhum projeto aberto no Premiere Pro.");
  }
  return project;
}
