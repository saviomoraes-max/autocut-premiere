// Empacota o painel UXP. "uxp" e "premierepro" são externals (providos pelo runtime).
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = {
  mode: "development",
  entry: "./src/index.ts",
  target: "web",
  devtool: false,
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "index.js",
    clean: true,
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
  },
  externalsType: "commonjs",
  externals: {
    uxp: "uxp",
    premierepro: "premierepro",
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: "ts-loader",
          // transpileOnly: o type-check é feito à parte com `npm run typecheck`,
          // e o tsconfig usa noEmit (incompatível com ts-loader emitindo).
          options: { transpileOnly: true },
        },
      },
      {
        // CSS importado como STRING (vai embutido no index.js e é injetado em runtime).
        // O UXP cacheia o styles.css em disco; embutir no JS garante o estilo novo a cada reload.
        test: /\.css$/,
        type: "asset/source",
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: "manifest.json" },
        { from: "index.html" },
        { from: "src/styles.css", to: "styles.css" },
      ],
    }),
  ],
};
