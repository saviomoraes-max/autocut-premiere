// Declaração mínima do módulo "uxp" (só o que usamos para registrar o painel).
// Doc: https://developer.adobe.com/premiere-pro/uxp/
declare module "uxp" {
  export const entrypoints: {
    setup(config: {
      panels?: Record<
        string,
        {
          show?: (event?: unknown) => void;
          hide?: (event?: unknown) => void;
          create?: (event?: unknown) => void;
          destroy?: (event?: unknown) => void;
        }
      >;
      commands?: Record<string, unknown>;
    }): void;
  };
}
