// `require` é provido pelo runtime do UXP (CommonJS). Tipamos de forma ampla e
// usamos cast no ponto de uso (com os tipos oficiais @adobe/premierepro).
declare function require(moduleName: string): any;

// CSS importado como STRING (webpack asset/source) — embutimos no bundle e injetamos
// em runtime, pra não depender do styles.css em disco (que o UXP cacheia).
declare module "*.css" {
  const content: string;
  export default content;
}
